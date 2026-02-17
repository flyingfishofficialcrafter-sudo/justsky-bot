require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const express = require("express");

// ====== DISCORD ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Sprawdza czy bot działa."),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Status sklepu / bota.")
].map(c => c.toJSON());

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.log("Brak DISCORD_TOKEN lub DISCORD_CLIENT_ID w ENV.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("✅ Slash commands zarejestrowane globalnie (/ping, /status).");
}

client.on("ready", async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply({ content: "🏓 Pong! Bot działa.", ephemeral: true });
  }

  if (interaction.commandName === "status") {
    return interaction.reply({
      content: "🟢 JustSky Shop Bot działa. Następny krok: PayPal + automatyczne nadawanie.",
      ephemeral: true
    });
  }
});

client.login(process.env.DISCORD_TOKEN);

// ====== WEB (Render lub lokalnie) ======
const app = express();
app.get("/", (req, res) => res.send("JustSky Bot działa ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web działa na porcie ${PORT}`));
