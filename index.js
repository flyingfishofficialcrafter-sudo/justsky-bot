const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const { Rcon } = require("rcon-client");

// ====== ENV (TWOJE NAZWY) ======
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET; // <-- u Ciebie tak
const PAYPAL_MODE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();

const SHOP_PANEL_CHANNEL_ID = process.env.SHOP_PANEL_CHANNEL_ID;
const SHOP_LOG_CHANNEL_ID = process.env.SHOP_LOG_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = process.env.RCON_PORT ? Number(process.env.RCON_PORT) : null;
const RCON_PASSWORD = process.env.RCON_PASSWORD;

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || ""; // na przyszłość, jeśli chcesz

// ====== VALIDATION ======
function must(v, name) {
  if (!v) throw new Error(`Brak ${name} w ENV`);
  return v;
}
must(DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID");
must(DISCORD_TOKEN, "DISCORD_TOKEN");
must(PAYPAL_CLIENT_ID, "PAYPAL_CLIENT_ID");
must(PAYPAL_SECRET, "PAYPAL_SECRET");
must(SHOP_PANEL_CHANNEL_ID, "SHOP_PANEL_CHANNEL_ID");
must(SHOP_LOG_CHANNEL_ID, "SHOP_LOG_CHANNEL_ID");
must(TICKET_CATEGORY_ID, "TICKET_CATEGORY_ID");

// RCON opcjonalny, ale jak chcesz auto-wydawanie to ustaw:
const RCON_ENABLED = !!(RCON_HOST && RCON_PORT && RCON_PASSWORD);

// ====== LOAD PRODUCTS ======
function loadProducts() {
  const p = path.join(__dirname, "products.json");
  const raw = fs.readFileSync(p, "utf8");
  const json = JSON.parse(raw);
  if (!json.products || !Array.isArray(json.products)) throw new Error("products.json: brak products[]");
  return json;
}
let PRODUCT_CFG = loadProducts();

function getProduct(id) {
  return PRODUCT_CFG.products.find(x => x.id === id) || null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function isValidMcNick(nick) {
  return /^[a-zA-Z0-9_]{3,16}$/.test(nick);
}
function money(n) {
  return `${Number(n).toFixed(2)} PLN`;
}
function buildCommands(prod, nick, qty) {
  return prod.commands.map(cmd =>
    cmd.replaceAll("{player}", nick).replaceAll("{amount}", String(qty))
  );
}

// ====== PAYPAL ======
const PAYPAL_API = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

async function paypalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

async function paypalCreateOrder(totalPLN, description, customId) {
  const token = await paypalAccessToken();
  const payload = {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: customId,
      custom_id: customId,
      description,
      amount: { currency_code: "PLN", value: totalPLN.toFixed(2) }
    }],
    application_context: {
      brand_name: "JustSky.pl",
      landing_page: "LOGIN",
      user_action: "PAY_NOW"
    }
  };

  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`PayPal create order error: ${res.status} ${JSON.stringify(json)}`);

  const approveLink = (json.links || []).find(l => l.rel === "approve")?.href;
  return { orderId: json.id, approveLink };
}

async function paypalGetOrder(orderId) {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`PayPal get order error: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function paypalCaptureOrder(orderId) {
  const token = await paypalAccessToken();
  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`PayPal capture error: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// ====== RCON EXEC ======
async function rconExec(commands) {
  if (!RCON_ENABLED) return { ok: false, reason: "RCON nieustawiony" };

  const rcon = await Rcon.connect({
    host: RCON_HOST,
    port: RCON_PORT,
    password: RCON_PASSWORD,
  });

  try {
    for (const cmd of commands) {
      await rcon.send(cmd);
    }
    return { ok: true };
  } finally {
    try { await rcon.end(); } catch {}
  }
}

// ====== STATE ======
const stateStore = new Map();          // channelId -> state
const activeTicketsByUser = new Map(); // userId -> channelId
const createCooldown = new Map();
const COOLDOWN_MS = 60_000;

function canCreateTicket(userId) {
  const now = Date.now();
  const cd = createCooldown.get(userId) || 0;
  if (now - cd < COOLDOWN_MS) {
    const s = Math.ceil((COOLDOWN_MS - (now - cd)) / 1000);
    return { ok: false, reason: `⏳ Poczekaj **${s}s**.` };
  }
  if (activeTicketsByUser.has(userId)) {
    return { ok: false, reason: `❌ Masz już ticket: <#${activeTicketsByUser.get(userId)}>` };
  }
  createCooldown.set(userId, now);
  return { ok: true };
}

function cleanupTicket(channelId) {
  const s = stateStore.get(channelId);
  if (s?.ownerId) activeTicketsByUser.delete(s.ownerId);
  stateStore.delete(channelId);
}

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// ====== UI ======
function buildMainPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("🛒 Sklep JustSky — SkyGen")
    .setColor(0x2ecc71)
    .setDescription(
      [
        "**Zakup:**",
        "1) Kliknij **Kup / Otwórz ticket**",
        "2) Wybierz produkt i ilość",
        "3) Podaj nick",
        "4) Zapłać PayPal → bot wyda na serwer",
        "",
        "✅ 1 ticket na osobę + anty-spam"
      ].join("\n")
    );
}

function buildMainPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("shop:openTicket")
        .setLabel("Kup / Otwórz ticket")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🧾")
    ),
  ];
}

function buildTicketPanelMessage(state) {
  const prod = state.productId ? getProduct(state.productId) : null;

  const embed = new EmbedBuilder()
    .setTitle("🧾 Ticket zakupu — JustSky")
    .setColor(0x00d1ff)
    .setDescription(
      [
        "**Kroki:**",
        "1) Wybierz produkt",
        "2) Ustaw ilość (+ / -)",
        "3) Podaj nick",
        "4) Kliknij **Zapłać**",
        "",
        state.paid ? "✅ **Płatność: ZAKOŃCZONA**" : "⏳ **Płatność: OCZEKUJE**",
      ].join("\n")
    )
    .addFields(
      { name: "Produkt", value: prod ? prod.name : "—", inline: true },
      { name: "Ilość", value: String(state.qty ?? 1), inline: true },
      { name: "Nick", value: state.nick ? `\`${state.nick}\`` : "—", inline: true }
    );

  if (prod) {
    const total = Number((prod.price * (state.qty ?? 1)).toFixed(2));
    embed.addFields({ name: "Suma", value: money(total), inline: true });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("shop:selectProduct")
    .setPlaceholder("Wybierz produkt…")
    .addOptions(PRODUCT_CFG.products.slice(0, 25).map(p => ({
      label: p.name,
      value: p.id,
      description: `${money(p.price)} / szt`
    })));

  const row1 = new ActionRowBuilder().addComponents(select);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("shop:qtyMinus").setStyle(ButtonStyle.Secondary).setEmoji("➖"),
    new ButtonBuilder().setCustomId("shop:qtyPlus").setStyle(ButtonStyle.Secondary).setEmoji("➕"),
    new ButtonBuilder().setCustomId("shop:enterNick").setStyle(ButtonStyle.Primary).setLabel("Podaj nick").setEmoji("👤")
  );

  const canPay = !!(state.productId && state.nick && !state.paid);
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("shop:pay").setStyle(ButtonStyle.Success).setLabel("Zapłać (PayPal)").setEmoji("💸").setDisabled(!canPay),
    new ButtonBuilder().setCustomId("shop:cancel").setStyle(ButtonStyle.Danger).setLabel("Reset").setEmoji("🗑️"),
    new ButtonBuilder().setCustomId("shop:close").setStyle(ButtonStyle.Secondary).setLabel("Zamknij ticket").setEmoji("🔒")
  );

  const rows = [row1, row2, row3];

  if (state.orderId && !state.paid) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("shop:checkPayment").setStyle(ButtonStyle.Primary).setLabel("Sprawdź płatność").setEmoji("✅"),
        new ButtonBuilder().setCustomId("shop:resetPayment").setStyle(ButtonStyle.Secondary).setLabel("Reset płatności").setEmoji("🔁")
      )
    );
  }

  return { embeds: [embed], components: rows };
}

// ====== SLASH COMMANDS ======
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("setupshop").setDescription("Wyślij panel sklepu na kanał panelu").toJSON(),
    new SlashCommandBuilder().setName("reloadproducts").setDescription("Przeładuj products.json").toJSON(),
  ];
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, must(process.env.GUILD_ID || process.env.GUILD || process.env.GUILD_ID, "GUILD_ID")), { body: commands });
}

// UWAGA: potrzebujesz GUILD_ID w ENV (dopisz to u siebie)
const GUILD_ID = process.env.GUILD_ID;
must(GUILD_ID, "GUILD_ID");

// ====== EVENTS ======
client.on("ready", async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    // slash
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setupshop") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: "❌ Tylko admin.", ephemeral: true });
        }
        const ch = await client.channels.fetch(SHOP_PANEL_CHANNEL_ID).catch(() => null);
        if (!ch) return interaction.reply({ content: "❌ Nie mogę znaleźć kanału panelu.", ephemeral: true });

        await ch.send({ embeds: [buildMainPanelEmbed()], components: buildMainPanelComponents() });
        return interaction.reply({ content: "✅ Panel wysłany.", ephemeral: true });
      }

      if (interaction.commandName === "reloadproducts") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: "❌ Tylko admin.", ephemeral: true });
        }
        PRODUCT_CFG = loadProducts();
        return interaction.reply({ content: "✅ products.json przeładowany.", ephemeral: true });
      }
    }

    // buttons
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === "shop:openTicket") {
        const check = canCreateTicket(interaction.user.id);
        if (!check.ok) return interaction.reply({ content: check.reason, ephemeral: true });

        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "❌ Brak guild.", ephemeral: true });

        const ticketName = `zakup-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, "");
        const ticketChannel = await guild.channels.create({
          name: ticketName.slice(0, 90),
          type: ChannelType.GuildText,
          parent: TICKET_CATEGORY_ID,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          ],
        });

        activeTicketsByUser.set(interaction.user.id, ticketChannel.id);

        const s = { ownerId: interaction.user.id, productId: null, qty: 1, nick: null, orderId: null, paid: false, panelMessageId: null };
        stateStore.set(ticketChannel.id, s);

        const msg = await ticketChannel.send(buildTicketPanelMessage(s));
        s.panelMessageId = msg.id;
        stateStore.set(ticketChannel.id, s);

        return interaction.reply({ content: `✅ Ticket: <#${ticketChannel.id}>`, ephemeral: true });
      }

      const channelId = interaction.channelId;
      const s = stateStore.get(channelId);

      if (id.startsWith("shop:") && id !== "shop:openTicket") {
        if (!s) return interaction.reply({ content: "❌ To nie ticket sklepu.", ephemeral: true });
        if (interaction.user.id !== s.ownerId && !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: "❌ To nie Twój ticket.", ephemeral: true });
        }
      }

      if (id === "shop:qtyMinus") {
        if (!s.productId) return interaction.reply({ content: "❌ Najpierw wybierz produkt.", ephemeral: true });
        const p = getProduct(s.productId);
        s.qty = clamp((s.qty || 1) - 1, p.minQty, p.maxQty);
        s.orderId = null;
        const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (msg) await msg.edit(buildTicketPanelMessage(s));
        return interaction.deferUpdate();
      }

      if (id === "shop:qtyPlus") {
        if (!s.productId) return interaction.reply({ content: "❌ Najpierw wybierz produkt.", ephemeral: true });
        const p = getProduct(s.productId);
        s.qty = clamp((s.qty || 1) + 1, p.minQty, p.maxQty);
        s.orderId = null;
        const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (msg) await msg.edit(buildTicketPanelMessage(s));
        return interaction.deferUpdate();
      }

      if (id === "shop:enterNick") {
        const modal = new ModalBuilder().setCustomId("shop:nickModal").setTitle("Podaj nick (Minecraft)");
        const nickInput = new TextInputBuilder()
          .setCustomId("nick")
          .setLabel("Nick z serwera (3-16 znaków)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(16)
          .setPlaceholder("np. Arceris");
        modal.addComponents(new ActionRowBuilder().addComponents(nickInput));
        return interaction.showModal(modal);
      }

      if (id === "shop:pay") {
        if (s.paid) return interaction.reply({ content: "✅ Już opłacone.", ephemeral: true });
        if (!s.productId) return interaction.reply({ content: "❌ Wybierz produkt.", ephemeral: true });
        if (!s.nick) return interaction.reply({ content: "❌ Podaj nick.", ephemeral: true });

        const p = getProduct(s.productId);
        const qty = clamp(s.qty || 1, p.minQty, p.maxQty);
        s.qty = qty;

        const total = Number((p.price * qty).toFixed(2));
        const customId = `js_${channelId}_${interaction.user.id}_${Date.now()}`;
        const { orderId, approveLink } = await paypalCreateOrder(total, `${p.name} x${qty} dla ${s.nick}`, customId);

        s.orderId = orderId;

        const panel = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (panel) await panel.edit(buildTicketPanelMessage(s));

        const e = new EmbedBuilder()
          .setTitle("💸 PayPal — płatność")
          .setColor(0x3498db)
          .setDescription(
            [
              `**Produkt:** ${p.name}`,
              `**Ilość:** ${qty}`,
              `**Nick:** \`${s.nick}\``,
              `**Kwota:** **${money(total)}**`,
              "",
              "1) Kliknij link i zapłać",
              "2) Wróć tutaj i kliknij **Sprawdź płatność**"
            ].join("\n")
          )
          .addFields({ name: "Link", value: approveLink || "❌ brak linku (spróbuj ponownie)" });

        return interaction.reply({ embeds: [e], ephemeral: true });
      }

      if (id === "shop:checkPayment") {
        if (!s.orderId) return interaction.reply({ content: "❌ Brak płatności do sprawdzenia.", ephemeral: true });
        if (s.paid) return interaction.reply({ content: "✅ Już opłacone.", ephemeral: true });

        await interaction.reply({ content: "🔎 Sprawdzam płatność…", ephemeral: true });

        const order = await paypalGetOrder(s.orderId);
        if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
          return interaction.followUp({ content: `⏳ Jeszcze nieopłacone. Status: **${order.status}**`, ephemeral: true });
        }

        if (order.status === "APPROVED") {
          const cap = await paypalCaptureOrder(s.orderId);
          if (cap.status !== "COMPLETED") {
            return interaction.followUp({ content: `❌ Capture nieudany. Status: **${cap.status}**`, ephemeral: true });
          }
        }

        s.paid = true;

        const p = getProduct(s.productId);
        const cmds = buildCommands(p, s.nick, s.qty);

        // LOG CHANNEL
        const logCh = await client.channels.fetch(SHOP_LOG_CHANNEL_ID).catch(() => null);
        if (logCh) {
          const le = new EmbedBuilder()
            .setTitle("✅ Płatność potwierdzona — komendy")
            .setColor(0x2ecc71)
            .addFields(
              { name: "Użytkownik", value: `<@${interaction.user.id}>`, inline: true },
              { name: "Produkt", value: p.name, inline: true },
              { name: "Ilość", value: String(s.qty), inline: true },
              { name: "Nick", value: `\`${s.nick}\``, inline: true },
              { name: "OrderID", value: `\`${s.orderId}\`` },
              { name: "Komendy", value: "```" + cmds.join("\n") + "```" }
            );
          await logCh.send({ embeds: [le] });
        }

        // RCON AUTO GIVE
        if (RCON_ENABLED) {
          const r = await rconExec(cmds);
          if (!r.ok) {
            await interaction.followUp({ content: `⚠️ Płatność OK, ale RCON nie poszedł: ${r.reason}`, ephemeral: true });
          }
        }

        const panel = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (panel) await panel.edit(buildTicketPanelMessage(s));

        return interaction.followUp({ content: "✅ Płatność potwierdzona. Wydanie poszło (logi / RCON).", ephemeral: true });
      }

      if (id === "shop:resetPayment") {
        s.orderId = null;
        const panel = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (panel) await panel.edit(buildTicketPanelMessage(s));
        return interaction.reply({ content: "🔁 Zresetowano płatność. Kliknij Zapłać ponownie.", ephemeral: true });
      }

      if (id === "shop:cancel") {
        s.productId = null;
        s.qty = 1;
        s.nick = null;
        s.orderId = null;
        s.paid = false;
        const panel = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (panel) await panel.edit(buildTicketPanelMessage(s));
        return interaction.reply({ content: "🗑️ Zresetowano formularz.", ephemeral: true });
      }

      if (id === "shop:close") {
        await interaction.reply({ content: "🔒 Zamykam ticket…", ephemeral: true });
        cleanupTicket(channelId);
        setTimeout(async () => { try { await interaction.channel.delete("Ticket zamknięty"); } catch {} }, 1200);
        return;
      }
    }

    // select menu
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId !== "shop:selectProduct") return;

      const s = stateStore.get(interaction.channelId);
      if (!s) return interaction.reply({ content: "❌ To nie ticket sklepu.", ephemeral: true });
      if (interaction.user.id !== s.ownerId && !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "❌ To nie Twój ticket.", ephemeral: true });
      }

      const productId = interaction.values[0];
      const p = getProduct(productId);
      if (!p) return interaction.reply({ content: "❌ Nieznany produkt.", ephemeral: true });

      s.productId = productId;
      s.qty = clamp(s.qty || 1, p.minQty, p.maxQty);
      s.orderId = null;
      s.paid = false;

      const panel = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
      if (panel) await panel.edit(buildTicketPanelMessage(s));

      return interaction.deferUpdate();
    }

    // modal
    if (interaction.isModalSubmit()) {
      if (interaction.customId !== "shop:nickModal") return;

      const s = stateStore.get(interaction.channelId);
      if (!s) return interaction.reply({ content: "❌ To nie ticket sklepu.", ephemeral: true });

      const nick = interaction.fields.getTextInputValue("nick").trim();
      if (!isValidMcNick(nick)) {
        return interaction.reply({ content: "❌ Zły nick. Dozwolone: 3-16 znaków, litery/cyfry/_", ephemeral: true });
      }

      s.nick = nick;
      s.orderId = null;
      s.paid = false;

      const panel = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
      if (panel) await panel.edit(buildTicketPanelMessage(s));

      return interaction.reply({ content: `✅ Nick ustawiony: **${nick}**`, ephemeral: true });
    }

  } catch (e) {
    console.error(e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Błąd. Sprawdź logi Render.", ephemeral: true });
      }
    } catch {}
  }
});

// ====== WEB (Render) ======
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_, res) => res.json({ ok: true, rcon: RCON_ENABLED, mode: PAYPAL_MODE }));
app.get("/products", (_, res) => res.json(PRODUCT_CFG));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Web OK na porcie", PORT));

// ====== START ======
client.login(DISCORD_TOKEN);
