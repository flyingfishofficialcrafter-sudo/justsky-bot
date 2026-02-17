require("dotenv").config();
const express = require("express");
const { Rcon } = require("rcon-client");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType
} = require("discord.js");

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,

  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_MODE = "sandbox",
  WEBHOOK_TOKEN,

  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,

  SHOP_PANEL_CHANNEL_ID,
  SHOP_LOG_CHANNEL_ID,
  TICKET_CATEGORY_ID
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.log("Brakuje DISCORD_TOKEN albo DISCORD_CLIENT_ID");
  process.exit(1);
}

const PAYPAL_API = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// ====== Produkty (edytuj nazwy/ceny/komendy) ======
const PRODUCTS = {
  zwykly_klucz: {
    name: "🔑 Klucz Zwykłej Skrzyni",
    pricePLN: 2.00,
    command: "getcase give {player} zwykla {amount}"
  },
  piekielny_klucz: {
    name: "🔥 Klucz Piekielnej Skrzyni",
    pricePLN: 5.00,
    command: "getcase give {player} piekielna {amount}"
  },
  tajemniczy_klucz: {
    name: "✨ Klucz Tajemniczej Skrzyni",
    pricePLN: 10.00,
    command: "getcase give {player} tajemnicza {amount}"
  },
  skycoin: {
    name: "🪙 SkyCoin",
    pricePLN: 0.20,
    command: "eco give {player} {amount}"
  },
  odlamki: {
    name: "💠 Odłamki",
    pricePLN: 0.05,
    minAmount: 200, // 200 * 0.05 = 10 PLN minimum (możesz zmienić)
    command: "odlamki add {player} {amount}"
  }
};

// ====== pamięć zamówień (prosto, działa na start) ======
const ORDERS = new Map(); // internalId -> order data

function makeInternalId() {
  return `JS-${Date.now().toString(36).toUpperCase()}`;
}

function fmtPLN(n) {
  return n.toFixed(2).replace(".", ",") + " PLN";
}

// ====== PayPal ======
async function paypalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) throw new Error("Brak PAYPAL_CLIENT_ID lub PAYPAL_SECRET");

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const r = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!r.ok) throw new Error("PayPal token error: " + await r.text());
  const data = await r.json();
  return data.access_token;
}

async function paypalCreateOrder({ internalId, totalPLN, description }) {
  const token = await paypalAccessToken();

  const body = {
    intent: "CAPTURE",
    purchase_units: [{
      custom_id: internalId,
      description: description.slice(0, 127),
      amount: {
        currency_code: "PLN",
        value: totalPLN.toFixed(2)
      }
    }],
    application_context: { user_action: "PAY_NOW" }
  };

  const r = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await r.json();
  if (!r.ok) throw new Error("PayPal create order error: " + JSON.stringify(data));

  const approveUrl = (data.links || []).find(l => l.rel === "approve")?.href;
  return { paypalOrderId: data.id, approveUrl };
}

async function paypalGetOrder(orderId) {
  const token = await paypalAccessToken();
  const r = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error("PayPal get order error: " + JSON.stringify(data));
  return data;
}

// ====== RCON ======
async function runRconCommand(cmd) {
  if (!RCON_HOST || !RCON_PORT || !RCON_PASSWORD) throw new Error("Brak RCON_HOST/RCON_PORT/RCON_PASSWORD w ENV");

  const rcon = await Rcon.connect({
    host: RCON_HOST,
    port: Number(RCON_PORT),
    password: RCON_PASSWORD
  });

  try {
    const res = await rcon.send(cmd);
    return res;
  } finally {
    rcon.end();
  }
}

function renderCommand(template, player, amount) {
  return template
    .replaceAll("{player}", player)
    .replaceAll("{amount}", String(amount));
}

// ====== Discord ======
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function log(text) {
  if (!SHOP_LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(SHOP_LOG_CHANNEL_ID);
    if (ch) ch.send({ content: text });
  } catch {}
}

// Slash: /panel (admin) żeby wstawić panel sklepu
const commands = [
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Wstaw panel sklepu (button) na kanał panelu.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log("✅ Komendy zarejestrowane (/panel)");
}

// UI builders
function shopPanelMessage() {
  const emb = new EmbedBuilder()
    .setTitle("🛒 JustSky — Sklep (Automatycznie)")
    .setDescription([
      "Kliknij **Kup**, a bot utworzy ticket.",
      "W tickecie wybierzesz produkt, ilość i wpiszesz nick.",
      "",
      "✅ PayPal / karta",
      "✅ Automatyczna realizacja"
    ].join("\n"));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_ticket")
      .setLabel("Kup")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("how_it_works")
      .setLabel("Jak to działa?")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [emb], components: [row] };
}

function productSelectRow() {
  const options = Object.entries(PRODUCTS).map(([key, p]) => ({
    label: p.name,
    value: key,
    description: `Cena: ${fmtPLN(p.pricePLN)} / szt.`
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("select_product")
      .setPlaceholder("Wybierz produkt…")
      .addOptions(options)
  );
}

function paymentRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("pay_paypal")
      .setLabel("Zapłać PayPal / Kartą")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("cancel_order")
      .setLabel("Anuluj")
      .setStyle(ButtonStyle.Danger)
  );
}

function nickModal() {
  const modal = new ModalBuilder()
    .setCustomId("nick_modal")
    .setTitle("Nick z Minecrafta");

  const input = new TextInputBuilder()
    .setCustomId("mc_nick")
    .setLabel("Wpisz swój nick (dokładnie)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(16);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function amountModal(min = 1) {
  const modal = new ModalBuilder()
    .setCustomId("amount_modal")
    .setTitle("Ilość");

  const input = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel(`Podaj ilość (min. ${min})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

client.once("ready", async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);
  await registerCommands();
});

// Ticket create helper
async function createTicket(guild, user) {
  if (!TICKET_CATEGORY_ID) throw new Error("Brak TICKET_CATEGORY_ID w ENV");

  const channel = await guild.channels.create({
    name: `zakup-${user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] }
    ]
  });

  const emb = new EmbedBuilder()
    .setTitle("🧾 Ticket zakupu — JustSky")
    .setDescription([
      "1) Wybierz produkt",
      "2) Wpisz ilość",
      "3) Wpisz nick",
      "4) Kliknij **Zapłać**",
      "",
      "⚠️ Płatność jest automatyczna — po opłaceniu bot nada produkt na serwerze."
    ].join("\n"));

  await channel.send({ content: `<@${user.id}>`, embeds: [emb], components: [productSelectRow()] });
  return channel;
}

// interaction handler
client.on("interactionCreate", async (i) => {
  try {
    // /panel
    if (i.isChatInputCommand() && i.commandName === "panel") {
      if (!SHOP_PANEL_CHANNEL_ID) {
        return i.reply({ content: "❌ Brak SHOP_PANEL_CHANNEL_ID w ENV.", ephemeral: true });
      }
      const ch = await client.channels.fetch(SHOP_PANEL_CHANNEL_ID);
      await ch.send(shopPanelMessage());
      return i.reply({ content: "✅ Panel sklepu wysłany.", ephemeral: true });
    }

    // buttons
    if (i.isButton()) {
      if (i.customId === "how_it_works") {
        return i.reply({
          content: "✅ Kup → Ticket → Wybór produktu/ilości/nick → PayPal → bot nadaje na serwerze.",
          ephemeral: true
        });
      }

      if (i.customId === "open_ticket") {
        const ch = await createTicket(i.guild, i.user);
        await log(`📩 Ticket: ${ch} utworzony przez ${i.user.tag}`);
        return i.reply({ content: `✅ Utworzyłem ticket: ${ch}`, ephemeral: true });
      }

      // pay
      if (i.customId === "pay_paypal") {
        const order = [...ORDERS.values()].find(o => o.channelId === i.channelId && o.userId === i.user.id && o.status === "READY_TO_PAY");
        if (!order) return i.reply({ content: "❌ Najpierw wybierz produkt/ilość/nick.", ephemeral: true });

        const p = PRODUCTS[order.productKey];
        const total = order.totalPLN;

        const { paypalOrderId, approveUrl } = await paypalCreateOrder({
          internalId: order.internalId,
          totalPLN: total,
          description: `${p.name} x${order.amount} | Nick: ${order.mcNick}`
        });

        order.paypalOrderId = paypalOrderId;
        order.status = "WAITING_PAYMENT";

        const emb = new EmbedBuilder()
          .setTitle("💳 Płatność PayPal")
          .setDescription([
            `**Zamówienie:** \`${order.internalId}\``,
            `**Produkt:** ${p.name}`,
            `**Ilość:** ${order.amount}`,
            `**Nick:** \`${order.mcNick}\``,
            `**Suma:** ${fmtPLN(total)}`,
            "",
            "Kliknij link i zapłać:",
            approveUrl || "(brak linku)"
          ].join("\n"));

        await log(`💳 PayPal link: ${order.internalId} | ${i.user.tag} | ${p.name} x${order.amount} | ${fmtPLN(total)}`);
        return i.reply({ embeds: [emb], ephemeral: false });
      }

      if (i.customId === "cancel_order") {
        // zamykamy ticket po anulowaniu
        await i.reply({ content: "❌ Anulowano. Zamykam ticket.", ephemeral: true });
        await log(`❌ Anulowano ticket ${i.channelId} przez ${i.user.tag}`);
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }
    }

    // select product
    if (i.isStringSelectMenu() && i.customId === "select_product") {
      const key = i.values[0];
      if (!PRODUCTS[key]) return i.reply({ content: "❌ Zły produkt.", ephemeral: true });

      // zapis w pamięci, potem ilość i nick
      const internalId = makeInternalId();
      ORDERS.set(internalId, {
        internalId,
        userId: i.user.id,
        channelId: i.channelId,
        guildId: i.guildId,
        productKey: key,
        amount: null,
        mcNick: null,
        totalPLN: null,
        status: "NEED_AMOUNT"
      });

      const min = PRODUCTS[key].minAmount || 1;
      await i.showModal(amountModal(min));
    }

    // modals
    if (i.isModalSubmit()) {
      // amount modal
      if (i.customId === "amount_modal") {
        const amountRaw = i.fields.getTextInputValue("amount").trim();
        const amount = Number(amountRaw);

        const order = [...ORDERS.values()].find(o => o.channelId === i.channelId && o.userId === i.user.id && o.status === "NEED_AMOUNT");
        if (!order) return i.reply({ content: "❌ Nie mogę znaleźć zamówienia.", ephemeral: true });

        const p = PRODUCTS[order.productKey];
        const min = p.minAmount || 1;

        if (!Number.isInteger(amount) || amount < min || amount > 999999) {
          return i.reply({ content: `❌ Zła ilość. Min: ${min}`, ephemeral: true });
        }

        order.amount = amount;
        order.totalPLN = Number((p.pricePLN * amount).toFixed(2));
        order.status = "NEED_NICK";

        await i.reply({ content: `✅ Ilość ustawiona: **${amount}**. Teraz podaj nick.`, ephemeral: true });
        return i.followUp({ ephemeral: true, content: "Otwieram okno na nick..." }).then(() => i.showModal(nickModal()));
      }

      // nick modal
      if (i.customId === "nick_modal") {
        const nick = i.fields.getTextInputValue("mc_nick").trim();

        const order = [...ORDERS.values()].find(o => o.channelId === i.channelId && o.userId === i.user.id && o.status === "NEED_NICK");
        if (!order) return i.reply({ content: "❌ Nie mogę znaleźć zamówienia.", ephemeral: true });

        // prosta walidacja nicku MC
        if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) {
          return i.reply({ content: "❌ Zły nick. Dozwolone: litery/cyfry/_ (3-16).", ephemeral: true });
        }

        order.mcNick = nick;
        order.status = "READY_TO_PAY";

        const p = PRODUCTS[order.productKey];
        const emb = new EmbedBuilder()
          .setTitle("✅ Podsumowanie zamówienia")
          .setDescription([
            `**Zamówienie:** \`${order.internalId}\``,
            `**Produkt:** ${p.name}`,
            `**Ilość:** ${order.amount}`,
            `**Nick:** \`${order.mcNick}\``,
            `**Suma:** ${fmtPLN(order.totalPLN)}`,
            "",
            "Wybierz płatność:"
          ].join("\n"));

        await log(`🧾 Zamówienie: ${order.internalId} | ${i.user.tag} | ${p.name} x${order.amount} | ${fmtPLN(order.totalPLN)} | nick ${nick}`);
        return i.reply({ embeds: [emb], components: [paymentRow()], ephemeral: false });
      }
    }

  } catch (e) {
    console.error(e);
    if (i && !i.replied) {
      try { await i.reply({ content: "❌ Błąd. Sprawdź logi Render.", ephemeral: true }); } catch {}
    }
  }
});

client.login(DISCORD_TOKEN);

// ====== WEBHOOK SERVER ======
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("JustSky Shop Bot online ✅"));

// ZABEZPIECZONE: /paypal/webhook?token=TWÓJ_TOKEN
app.post("/paypal/webhook", async (req, res) => {
  try {
    if (WEBHOOK_TOKEN && req.query.token !== WEBHOOK_TOKEN) {
      return res.status(401).send("unauthorized");
    }

    const event = req.body;
    const type = event.event_type;

    if (type === "PAYMENT.CAPTURE.COMPLETED") {
      const paypalOrderId =
        event.resource?.supplementary_data?.related_ids?.order_id ||
        event.resource?.supplementary_data?.related_ids?.order ||
        null;

      if (!paypalOrderId) return res.sendStatus(200);

      const order = await paypalGetOrder(paypalOrderId);
      const internalId = order.purchase_units?.[0]?.custom_id;

      if (!internalId) return res.sendStatus(200);

      const stored = [...ORDERS.values()].find(o => o.internalId === internalId);
      if (!stored) return res.sendStatus(200);
      if (stored.status === "PAID") return res.sendStatus(200);

      stored.status = "PAID";

      // Nadaj na serwerze (RCON -> komenda pluginu)
      const p = PRODUCTS[stored.productKey];
      const cmd = renderCommand(p.command, stored.mcNick, stored.amount);

      let rconRes = "";
      try {
        rconRes = await runRconCommand(cmd);
      } catch (err) {
        await log(`⚠️ OPŁACONE, ALE RCON PADŁ: ${stored.internalId} | cmd: \`${cmd}\``);
        return res.sendStatus(200);
      }

      // info na ticket
      try {
        const ch = await client.channels.fetch(stored.channelId);
        if (ch) {
          const emb = new EmbedBuilder()
            .setTitle("✅ Płatność potwierdzona")
            .setDescription([
              `**Zamówienie:** \`${stored.internalId}\``,
              `**Produkt:** ${p.name}`,
              `**Ilość:** ${stored.amount}`,
              `**Nick:** \`${stored.mcNick}\``,
              "",
              `✅ Nadano na serwerze komendą:`,
              `\`${cmd}\``
            ].join("\n"));
          await ch.send({ embeds: [emb] });
          await ch.send({ content: "Ticket zamknie się za 30 sekund." });
          setTimeout(() => ch.delete().catch(() => {}), 30000);
        }
      } catch {}

      await log(`✅ OPŁACONE + NADANE: ${stored.internalId} | ${stored.productKey} x${stored.amount} | nick ${stored.mcNick} | cmd: ${cmd} | rcon: ${String(rconRes).slice(0,200)}`);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Webhook server działa na porcie", PORT));

