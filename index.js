require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const app = express();

// Настройка Google Sheets
const jwtClient = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheetsApi = google.sheets({ version: 'v4', auth: jwtClient });

async function authorize() {
  await jwtClient.authorize();
}

function shuffle(array) {
  return array
    .map(value => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}

async function loadQuiz() {
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Вопросы!A1:Z1000',
  });

  const rows = data.values || [];
  if (rows.length < 3) throw new Error('Недостаточно строк в листе "Вопросы"');

  const questions = rows[0];
  const corrects = rows[1];
  const optionsRows = rows.slice(2);

  const quiz = questions.map((q, i) => {
    const allOptions = optionsRows.map(row => row[i]).filter(Boolean);
    const correct = corrects[i];
    const shuffled = shuffle(allOptions);
    return {
      text: q,
      correct: correct,
      options: shuffled
    };
  });

  return shuffle(quiz);
}

async function saveResults(username, firstName, lastName, answers, scoreStr) {
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Опрос',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[username, firstName, lastName, ...answers, scoreStr]]
    },
  });
}


const sessions = {};

bot.start(ctx => {
  ctx.reply('Викторина ко Дню кадровика: Проверь свои знания в HR!', Markup.inlineKeyboard([
    Markup.button.callback('Начать опрос', 'START')
  ]));
});

bot.action('START', async ctx => {
  try {
    const quiz = await loadQuiz();
    sessions[ctx.from.id] = { quiz, index: 0, answers: [] };
    sendQuestion(ctx);
  } catch (err) {
    console.error(err);
    ctx.reply('Не удалось загрузить опрос. Попробуйте позже.');
  }
});

function sendQuestion(ctx) {
  const s = sessions[ctx.from.id];
  const qObj = s.quiz[s.index];
  const keyboard = qObj.options.map(opt => [opt]);
  ctx.reply(
    qObj.text,
    Markup.keyboard(keyboard).oneTime().resize()
  );
}

bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const userId = ctx.from.id;
  const s = sessions[userId];
  if (!s) return;

  const answer = ctx.message.text;
  s.answers[s.index] = answer;
  s.index++;

  await ctx.reply('Ваш ответ принят', Markup.removeKeyboard());

  if (s.index < s.quiz.length) {
    return sendQuestion(ctx);
  }

  const results = s.quiz.map((q, i) => ({
    question: q.text,
    correct: q.correct,
    answer: s.answers[i] || ''
  }));
  const score = results.filter(r => r.answer === r.correct).length;
  const summary = results.map(r =>
    `❓ ${r.question}\n✅ ${r.correct}\n📝 ${r.answer}`
  ).join('\n\n') + `\n\n🎉 Правильно: ${score}/${results.length}`;

  await ctx.reply(summary);

  const username = ctx.from.username || userId;
  await saveResults(username, s.answers, `${score}/${results.length}`);
  await bot.telegram.sendMessage(
    process.env.RESULTS_CHAT_ID,
    `Пользователь ${username} завершил опрос: ${score}/${results.length}`
  );
  delete sessions[userId];
});

// === Express-сервер для вебхука ===
const PORT = process.env.PORT || 3000;

app.use(bot.webhookCallback('/bot'));
bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/bot`);

app.get('/', (req, res) => res.send('Бот работает'));

(async () => {
  try {
    await authorize();
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });
  } catch (err) {
    console.error('Ошибка инициализации:', err);
  }
})();

