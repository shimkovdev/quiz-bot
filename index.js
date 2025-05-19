require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

// Инициализация бота
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// Настройка аутентификации Google Sheets через JWT
const jwtClient = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  // private_key нужно хранить с экранированными \\n, а здесь превращать в реальные переводы строк
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheetsApi = google.sheets({ version: 'v4', auth: jwtClient });

// Убедимся, что авторизация прошла
async function authorize() {
  await jwtClient.authorize();
}

// Загрузка викторины из листа "Вопросы"
async function loadQuiz() {
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Вопросы!A1:Z1000',  // охватите достаточный диапазон
  });
  const rows = data.values || [];
  if (rows.length < 2) throw new Error('Недостаточно строк в листе "Вопросы"');

  const header = rows[0];       // первая строка — тексты вопросов
  const corrects = rows[1];     // вторая строка — правильные ответы
  const optionsRows = rows.slice(2);  // с третьей — варианты

  return header.map((q, i) => ({
    text: q,
    correct: corrects[i] || '',
    options: optionsRows.map(r => r[i]).filter(o => o),
  }));
}

// Запись результатов в лист "Опрос"
async function saveResults(username, answers, scoreStr) {
  // Автоматически добавит новые столбцы под каждый ответ
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Опрос',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [
        [ username, ...answers, scoreStr ]
      ]
    }
  });
}

// Бот
const sessions = {};

bot.start(ctx => {
  ctx.reply('Привет! Готов пройти опрос?', Markup.inlineKeyboard([
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
  const q = s.quiz[s.index];
  ctx.editMessageText(q.text, Markup.inlineKeyboard(
    q.options.map(o => Markup.button.callback(o, `ANS_${s.index}_${o}`))
  ));
}

bot.action(/ANS_(\d+)_(.+)/, async ctx => {
  const [ , idxStr, answer ] = ctx.match;
  const userId = ctx.from.id;
  const s = sessions[userId];
  const idx = parseInt(idxStr, 10);
  s.answers[idx] = answer;
  s.index++;

  if (s.index < s.quiz.length) {
    return sendQuestion(ctx);
  }

  // Подведение итогов
  const results = s.quiz.map((q, i) => ({
    question: q.text,
    correct: q.correct,
    answer: s.answers[i] || ''
  }));
  const score = results.filter(r => r.answer === r.correct).length;
  const summary = results.map(r =>
    `❓ ${r.question}\n✅ ${r.correct}\n📝 ${r.answer}`
  ).join('\n\n') + `\n\n🎉 Правильно: ${score}/${results.length}`;

  await ctx.editMessageText(summary);
  const username = ctx.from.username || ctx.from.id;
  await saveResults(username, s.answers, `${score}/${results.length}`);
  await bot.telegram.sendMessage(
    process.env.RESULTS_CHAT_ID,
    `Пользователь ${username} завершил опрос: ${score}/${results.length}`
  );
  delete sessions[userId];
});

// Запуск
(async () => {
  try {
    await authorize();
    await bot.launch();
    console.log('Бот запущен!');
  } catch (err) {
    console.error('Ошибка инициализации бота:', err);
  }
})();

