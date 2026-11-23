require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Найти песню или включить её по ссылке')
    .addStringOption(option => option.setName('запрос').setDescription('Название песни или ссылка').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Переключить на следующий трек'),
  new SlashCommandBuilder().setName('stop').setDescription('Остановить музыку и очистить очередь'),
].map(command => command.toJSON());

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Заполни DISCORD_TOKEN и CLIENT_ID в файле .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
(async () => {
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(GUILD_ID ? 'Команды зарегистрированы на сервере.' : 'Команды зарегистрированы глобально (обновление может занять время).');
})().catch(error => { console.error('Не удалось зарегистрировать команды:', error); process.exit(1); });
