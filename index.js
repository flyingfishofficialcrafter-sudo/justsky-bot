/**
 * JustSky Shop Bot — 1 plik index.js
 * Discord.js v14 + PayPal (create order -> approve -> check -> capture -> deliver)
 *
 * ENV REQUIRED:
 * DISCORD_TOKEN=...
 * GUILD_ID=...
 * SHOP_PANEL_CHANNEL_ID=...         (kanał gdzie ma być panel)
 * SHOP_LOG_CHANNEL_ID=...           (kanał logów/komend do MC dla adminów)
 * SHOP_TICKETS_CATEGORY_ID=...      (kategoria na tickety)
 *
 * PAYPAL_CLIENT_ID=...
 * PAYPAL_CLIENT_SECRET=...
 * PAYPAL_MODE=sandbox | live
 *
 * OPTIONAL:
 * BASE_URL=https://twoj-bot.onrender.com   (jak masz; nie jest wymagane w tym flow)
 * MC_WEBHOOK_URL=https://...              (jeśli masz plugin/webhook do wykonywania komend)
 *
 * Komendy:
 * /setupshop  -> wysyła panel w SHOP_PANEL_CHANNEL_ID
 */

const express = require("express");
const crypto = require("crypto");
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

// ===================== ENV =====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const SHOP_PANEL_CHANNEL_ID = process.env.SHOP_PANEL_CHANNEL_ID;
const SHOP_LOG_CHANNEL_ID = process.env.SHOP_LOG_CHANNEL_ID;
const SHOP_TICKETS_CATEGORY_ID = process.env.SHOP_TICKETS_CATEGORY_ID;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();

const BASE_URL = process.env.BASE_URL || "";
const MC_WEBHOOK_URL = process.env.MC_WEBHOOK_URL || "";

// ===================== BASIC VALIDATION =====================
if (!DISCORD_TOKEN) throw new Error("Brak DISCORD_TOKEN w ENV");
if (!GUILD_ID) throw new Error("Brak GUILD_ID w ENV");
if (!SHOP_PANEL_CHANNEL_ID) throw new Error("Brak SHOP_PANEL_CHANNEL_ID w ENV");
if (!SHOP_LOG_CHANNEL_ID) throw new Error("Brak SHOP_LOG_CHANNEL_ID w ENV");
if (!SHOP_TICKETS_CATEGORY_ID) throw new Error("Brak SHOP_TICKETS_CATEGORY_ID w ENV");
if (!PAYPAL_CLIENT_ID) throw new Error("Brak PAYPAL_CLIENT_ID w ENV");
if (!PAYPAL_CLIENT_SECRET) throw new Error("Brak PAYPAL_CLIENT_SECRET w ENV");

// ===================== PAYPAL ENDPOINT =====================
const PAYPAL_API = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// ===================== PRODUCTS (TU USTAWIASZ KOMENDY MC) =====================
// Podmień nazwy / ceny / komendy na swoje.
const PRODUCTS = {
  key_zwykla: {
    id: "key_zwykla",
    name: "🔑 Klucz Zwykłej Skrzyni",
    pricePLN: 2.46,
    minQty: 1,
    maxQty: 64,
    commands: [
      // {player} = nick, {amount} = ilość
      "crates key give {player} zwykla {amount}"
    ],
  },
  key_piekielna: {
    id: "key_piekielna",
    name: "🔥 Klucz Piekielnej Skrzyni",
    pricePLN: 6.15,
    minQty: 1,
    maxQty: 64,
    commands: [
      "crates key give {player} piekielna {amount}"
    ],
  },
  key_tajemnicza: {
    id: "key_tajemnicza",
    name: "🟣 Klucz Tajemniczej Skrzyni",
    pricePLN: 12.30,
    minQty: 1,
    maxQty: 64,
    commands: [
      "crates key give {player} tajemnicza {amount}"
    ],
  },

  skycoin_100: {
    id: "skycoin_100",
    name: "💠 SkyCoin x100",
    pricePLN: 3.99,
    minQty: 1,
    maxQty: 100,
    commands: [
      "eco give {player} 100"
    ],
  },
};

// ===================== STATE / SECURITY =====================
const stateStore = new Map();          // channelId -> { ownerId, productId, qty, nick, panelMessageId, orderId, paid }
const activeTicketsByUser = new Map(); // userId -> channelId
const createCooldown = new Map();      // userId -> timestamp
const COOLDOWN_MS = 60_000;

// ===================== HELPERS =====================
function moneyPLN(n) {
  return `${n.toFixed(2)} PLN`;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function isValidMcNick(nick) {
  return /^[a-zA-Z0-9_]{3,16}$/.test(nick);
}
function buildCommands(product, nick, qty) {
  return product.commands.map(cmd =>
    cmd.replaceAll("{player}", nick).replaceAll("{amount}", String(qty))
  );
}

function calcTotal(product, qty) {
  // PayPal lubi string z 2 miejscami.
  const total = product.pricePLN * qty;
  return Number(total.toFixed(2));
}

// ===================== PAYPAL API =====================
async function paypalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`PayPal token error: ${res.status} ${t}`);
  }

  const json = await res.json();
  return json.access_token;
}

async function paypalCreateOrder({ totalPLN, description, customId }) {
  const token = await paypalAccessToken();

  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: customId,
        description,
        custom_id: customId,
        amount: {
          currency_code: "PLN",
          value: totalPLN.toFixed(2),
        },
      },
    ],
    application_context: {
      brand_name: "JustSky.pl",
      landing_page: "LOGIN",
      user_action: "PAY_NOW",
    },
  };

  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`PayPal create order error: ${res.status} ${JSON.stringify(json)}`);
  }

  const approveLink = (json.links || []).find(l => l.rel === "approve")?.href;
  return { orderId: json.id, approveLink };
}

async function paypalGetOrder(orderId) {
  const token = await paypalAccessToken();

  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`PayPal get order error: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function paypalCaptureOrder(orderId) {
  const token = await paypalAccessToken();

  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`PayPal capture error: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// ===================== DISCORD BOT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ===== Slash commands register =====
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setupshop")
      .setDescription("Wyślij panel sklepu na kanał panelu")
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands((await client.application.fetch()).id, GUILD_ID), {
    body: commands,
  });
}

// ===================== UI BUILDERS =====================
function buildMainPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("🛒 Sklep JustSky — SkyGen")
    .setDescription(
      [
        "**Zakup w 30 sekund:**",
        "1) Kliknij **Kup / Otwórz ticket**",
        "2) Wybierz produkt i ilość",
        "3) Podaj nick",
        "4) Zapłać PayPal → odbierz automatycznie",
        "",
        "⚠️ Jeden ticket na osobę. Nie spamuj — bot blokuje.",
      ].join("\n")
    )
    .setColor(0x2ecc71);
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
  const product = state.productId ? PRODUCTS[state.productId] : null;

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
      { name: "Produkt", value: product ? product.name : "—", inline: true },
      { name: "Ilość", value: String(state.qty ?? 1), inline: true },
      { name: "Nick", value: state.nick ? `\`${state.nick}\`` : "—", inline: true },
    );

  if (product) {
    const total = calcTotal(product, state.qty || 1);
    embed.addFields({ name: "Suma", value: moneyPLN(total), inline: true });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("shop:selectProduct")
    .setPlaceholder("Wybierz produkt…")
    .addOptions(
      Object.values(PRODUCTS).slice(0, 25).map(p => ({
        label: p.name,
        value: p.id,
        description: `${moneyPLN(p.pricePLN)} / szt`,
      }))
    );

  const row1 = new ActionRowBuilder().addComponents(select);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("shop:qtyMinus").setStyle(ButtonStyle.Secondary).setEmoji("➖"),
    new ButtonBuilder().setCustomId("shop:qtyPlus").setStyle(ButtonStyle.Secondary).setEmoji("➕"),
    new ButtonBuilder().setCustomId("shop:enterNick").setStyle(ButtonStyle.Primary).setLabel("Podaj nick").setEmoji("👤"),
  );

  const canPay = !!(state.productId && state.nick && !state.paid);
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("shop:pay")
      .setStyle(ButtonStyle.Success)
      .setLabel("Zapłać (PayPal)")
      .setEmoji("💸")
      .setDisabled(!canPay),
    new ButtonBuilder()
      .setCustomId("shop:cancel")
      .setStyle(ButtonStyle.Danger)
      .setLabel("Anuluj")
      .setEmoji("🗑️"),
    new ButtonBuilder()
      .setCustomId("shop:close")
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Zamknij ticket")
      .setEmoji("🔒")
  );

  // Jeśli jest zamówienie, pokaż row z check
  const rows = [row1, row2, row3];

  if (state.orderId && !state.paid) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("shop:checkPayment")
          .setStyle(ButtonStyle.Primary)
          .setLabel("Sprawdź płatność")
          .setEmoji("✅"),
        new ButtonBuilder()
          .setCustomId("shop:resetPayment")
          .setStyle(ButtonStyle.Secondary)
          .setLabel("Reset płatności")
          .setEmoji("🔁")
      )
    );
  }

  return { embeds: [embed], components: rows };
}

// ===================== TICKET SECURITY =====================
function canCreateTicket(userId) {
  const now = Date.now();
  const cd = createCooldown.get(userId) || 0;

  if (now - cd < COOLDOWN_MS) {
    const s = Math.ceil((COOLDOWN_MS - (now - cd)) / 1000);
    return { ok: false, reason: `⏳ Poczekaj **${s}s** i spróbuj ponownie.` };
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

// ===================== DISCORD EVENTS =====================
client.on("ready", async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);
  await registerCommands();
});

// Slash /setupshop
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setupshop") {
        // admin only
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: "❌ Tylko admin.", ephemeral: true });
        }

        const ch = await client.channels.fetch(SHOP_PANEL_CHANNEL_ID).catch(() => null);
        if (!ch) return interaction.reply({ content: "❌ Nie mogę znaleźć kanału panelu.", ephemeral: true });

        await ch.send({
          embeds: [buildMainPanelEmbed()],
          components: buildMainPanelComponents(),
        });

        return interaction.reply({ content: "✅ Panel wysłany.", ephemeral: true });
      }
    }

    // Button / Select / Modal
    if (interaction.isButton()) {
      const id = interaction.customId;

      // ===== open ticket =====
      if (id === "shop:openTicket") {
        const check = canCreateTicket(interaction.user.id);
        if (!check.ok) return interaction.reply({ content: check.reason, ephemeral: true });

        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "❌ Brak guild.", ephemeral: true });

        const ticketName = `zakup-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, "");
        const ticketChannel = await guild.channels.create({
          name: ticketName.slice(0, 90),
          type: ChannelType.GuildText,
          parent: SHOP_TICKETS_CATEGORY_ID,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          ],
        });

        activeTicketsByUser.set(interaction.user.id, ticketChannel.id);

        const initState = {
          ownerId: interaction.user.id,
          productId: null,
          qty: 1,
          nick: null,
          panelMessageId: null,
          orderId: null,
          paid: false,
        };
        stateStore.set(ticketChannel.id, initState);

        const msg = await ticketChannel.send(buildTicketPanelMessage(initState));
        initState.panelMessageId = msg.id;
        stateStore.set(ticketChannel.id, initState);

        return interaction.reply({ content: `✅ Ticket utworzony: <#${ticketChannel.id}>`, ephemeral: true });
      }

      // poniższe akcje tylko w ticketach + owner tylko
      const channelId = interaction.channelId;
      const s = stateStore.get(channelId);

      if (id.startsWith("shop:") && id !== "shop:openTicket") {
        if (!s) return interaction.reply({ content: "❌ To nie jest ticket sklepu.", ephemeral: true });
        if (interaction.user.id !== s.ownerId && !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: "❌ To nie Twój ticket.", ephemeral: true });
        }
      }

      // ===== qty - =====
      if (id === "shop:qtyMinus") {
        if (!s.productId) return interaction.reply({ content: "❌ Najpierw wybierz produkt.", ephemeral: true });

        const p = PRODUCTS[s.productId];
        const next = clamp((s.qty || 1) - 1, p.minQty, p.maxQty);
        s.qty = next;
        stateStore.set(channelId, s);

        const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (msg) await msg.edit(buildTicketPanelMessage(s));

        return interaction.deferUpdate();
      }

      // ===== qty + =====
      if (id === "shop:qtyPlus") {
        if (!s.productId) return interaction.reply({ content: "❌ Najpierw wybierz produkt.", ephemeral: true });

        const p = PRODUCTS[s.productId];
        const next = clamp((s.qty || 1) + 1, p.minQty, p.maxQty);
        s.qty = next;
        stateStore.set(channelId, s);

        const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (msg) await msg.edit(buildTicketPanelMessage(s));

        return interaction.deferUpdate();
      }

      // ===== enter nick (MODAL) — FIX: zero reply/defer przed showModal =====
      if (id === "shop:enterNick") {
        const modal = new ModalBuilder()
          .setCustomId("shop:nickModal")
          .setTitle("Podaj nick (Minecraft)");

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

      // ===== pay =====
      if (id === "shop:pay") {
        if (s.paid) return interaction.reply({ content: "✅ Już opłacone.", ephemeral: true });
        if (!s.productId) return interaction.reply({ content: "❌ Wybierz produkt.", ephemeral: true });
        if (!s.nick) return interaction.reply({ content: "❌ Podaj nick.", ephemeral: true });

        const p = PRODUCTS[s.productId];
        const qty = clamp(s.qty || 1, p.minQty, p.maxQty);
        s.qty = qty;

        const total = calcTotal(p, qty);
        const customId = `js_${channelId}_${interaction.user.id}_${Date.now()}`;

        // utwórz order
        const { orderId, approveLink } = await paypalCreateOrder({
          totalPLN: total,
          description: `${p.name} x${qty} dla ${s.nick}`,
          customId,
        });

        s.orderId = orderId;
        stateStore.set(channelId, s);

        const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (msg) await msg.edit(buildTicketPanelMessage(s));

        const payEmbed = new EmbedBuilder()
          .setTitle("💸 Płatność PayPal")
          .setColor(0x3498db)
          .setDescription(
            [
              `**Produkt:** ${p.name}`,
              `**Ilość:** ${qty}`,
              `**Nick:** \`${s.nick}\``,
              `**Kwota:** **${moneyPLN(total)}**`,
              "",
              "1) Kliknij link i zapłać",
              "2) Wróć tutaj i kliknij **Sprawdź płatność**",
            ].join("\n")
          )
          .addFields({ name: "Link do płatności", value: approveLink || "❌ brak (spróbuj ponownie)" });

        return interaction.reply({ embeds: [payEmbed], ephemeral: true });
      }

      // ===== check payment =====
      if (id === "shop:checkPayment") {
        if (!s.orderId) return interaction.reply({ content: "❌ Brak płatności do sprawdzenia.", ephemeral: true });
        if (s.paid) return interaction.reply({ content: "✅ Już opłacone.", ephemeral: true });

        const p = s.productId ? PRODUCTS[s.productId] : null;
        if (!p) return interaction.reply({ content: "❌ Brak produktu w stanie.", ephemeral: true });

        await interaction.reply({ content: "🔎 Sprawdzam płatność…", ephemeral: true });

        const order = await paypalGetOrder(s.orderId);

        // status: CREATED / APPROVED / COMPLETED
        if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
          return interaction.followUp({ content: `⏳ Jeszcze nieopłacone. Status PayPal: **${order.status}**`, ephemeral: true });
        }

        // capture jeśli trzeba
        if (order.status === "APPROVED") {
          const cap = await paypalCaptureOrder(s.orderId);
          if (cap.status !== "COMPLETED") {
            return interaction.followUp({ content: `❌ Capture nieudany. Status: **${cap.status}**`, ephemeral: true });
          }
        }

        // wydanie
        s.paid = true;
        stateStore.set(channelId, s);

        const cmds = buildCommands(p, s.nick, s.qty);

        // kanał logów
        const logCh = await client.channels.fetch(SHOP_LOG_CHANNEL_ID).catch(() => null);
        if (logCh) {
          const logEmbed = new EmbedBuilder()
            .setTitle("✅ Nowa płatność — WYDANIE")
            .setColor(0x2ecc71)
            .addFields(
              { name: "Użytkownik", value: `<@${interaction.user.id}>`, inline: true },
              { name: "Produkt", value: p.name, inline: true },
              { name: "Ilość", value: String(s.qty), inline: true },
              { name: "Nick", value: `\`${s.nick}\``, inline: true },
              { name: "OrderID", value: `\`${s.orderId}\``, inline: false },
              { name: "Komendy", value: "```" + cmds.join("\n") + "```", inline: false },
            );
          await logCh.send({ embeds: [logEmbed] });
        }

        // opcjonalny webhook do MC (jeśli masz swój)
        if (MC_WEBHOOK_URL) {
          try {
            await fetch(MC_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                orderId: s.orderId,
                productId: p.id,
                productName: p.name,
                qty: s.qty,
                nick: s.nick,
                commands: cmds,
              }),
            });
          } catch (e) {
            // nie przerywaj — logi i tak poszły
            console.log("MC_WEBHOOK error:", e?.message || e);
          }
        }

        // update panel
        const panelMsg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (panelMsg) await panelMsg.edit(buildTicketPanelMessage(s));

        await interaction.followUp({ content: "✅ Płatność potwierdzona! Produkt zostanie wydany (logi poszły do administracji).", ephemeral: true });

        return;
      }

      // ===== reset payment =====
      if (id === "shop:resetPayment") {
        s.orderId = null;
        stateStore.set(channelId, s);

        const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (msg) await msg.edit(buildTicketPanelMessage(s));

        return interaction.reply({ content: "🔁 Zresetowano płatność. Kliknij **Zapłać** jeszcze raz.", ephemeral: true });
      }

      // ===== cancel =====
      if (id === "shop:cancel") {
        s.productId = null;
        s.qty = 1;
        s.nick = null;
        s.orderId = null;
        s.paid = false;
        stateStore.set(channelId, s);

        const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
        if (msg) await msg.edit(buildTicketPanelMessage(s));

        return interaction.reply({ content: "🗑️ Zresetowano formularz w tickecie.", ephemeral: true });
      }

      // ===== close =====
      if (id === "shop:close") {
        await interaction.reply({ content: "🔒 Zamykam ticket…", ephemeral: true });
        cleanupTicket(channelId);

        setTimeout(async () => {
          try {
            await interaction.channel.delete("Ticket zamknięty");
          } catch {}
        }, 1500);

        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId !== "shop:selectProduct") return;

      const channelId = interaction.channelId;
      const s = stateStore.get(channelId);
      if (!s) return interaction.reply({ content: "❌ To nie jest ticket sklepu.", ephemeral: true });

      if (interaction.user.id !== s.ownerId && !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "❌ To nie Twój ticket.", ephemeral: true });
      }

      const productId = interaction.values[0];
      const p = PRODUCTS[productId];
      if (!p) return interaction.reply({ content: "❌ Nieznany produkt.", ephemeral: true });

      s.productId = productId;
      s.qty = clamp(s.qty || 1, p.minQty, p.maxQty);
      s.orderId = null;
      s.paid = false;
      stateStore.set(channelId, s);

      const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
      if (msg) await msg.edit(buildTicketPanelMessage(s));

      return interaction.deferUpdate();
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId !== "shop:nickModal") return;

      const channelId = interaction.channelId;
      const s = stateStore.get(channelId);
      if (!s) return interaction.reply({ content: "❌ To nie jest ticket sklepu.", ephemeral: true });

      if (interaction.user.id !== s.ownerId && !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "❌ To nie Twój ticket.", ephemeral: true });
      }

      const nick = interaction.fields.getTextInputValue("nick").trim();

      if (!isValidMcNick(nick)) {
        return interaction.reply({ content: "❌ Zły nick. Dozwolone: 3-16 znaków, litery/cyfry/_", ephemeral: true });
      }

      s.nick = nick;
      s.orderId = null;
      s.paid = false;
      stateStore.set(channelId, s);

      const msg = await interaction.channel.messages.fetch(s.panelMessageId).catch(() => null);
      if (msg) await msg.edit(buildTicketPanelMessage(s));

      return interaction.reply({ content: `✅ Nick ustawiony: **${nick}**. Teraz kliknij **Zapłać**.`, ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Wystąpił błąd. Sprawdź logi.", ephemeral: true });
      }
    } catch {}
  }
});

// ===================== KEEP ALIVE (Render) =====================
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Web server OK"));

// ===================== START =====================
client.login(DISCORD_TOKEN);
