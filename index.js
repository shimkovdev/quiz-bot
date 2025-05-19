require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

// Инициализация бота
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// Настройка Google Sheets через JWT
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

  const questions = rows[0];     // строка с текстами вопросов
  const corrects = rows[1];      // строка с правильными вариантами
  const optionsRows = rows.slice(2); // строки с вариантами

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

  return shuffle(quiz); // перемешиваем порядок вопросов
}


// Сохранение результатов
async function saveResults(username, answers, scoreStr) {
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Опрос',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[username, ...answers, scoreStr]] },
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

// После старта или после каждого ответа:
function sendQuestion(ctx) {
  const s = sessions[ctx.from.id];
  const qObj = s.quiz[s.index];

  // Формируем обычные кнопки (каждая — одна строка)
  const keyboard = qObj.options.map(opt => [ opt ]);

  // Отправляем вопрос вместе с Reply Keyboard
  ctx.reply(
    qObj.text,
    Markup.keyboard(keyboard)
      .oneTime()        // клавиатура исчезнет после выбора
      .resize()         // подгонит размер
  );
}

// Вместо bot.action — используем bot.on('text')
// (но игнорируем команду /start)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const s = sessions[userId];
  if (!s) return;                      // если нет активной сессии — игнор

  const answer = ctx.message.text;     // полный текст варианта
  s.answers[s.index] = answer;
  s.index++;

  // Убираем Reply Keyboard
  await ctx.reply('Ваш ответ принят', Markup.removeKeyboard());

  if (s.index < s.quiz.length) {
    return sendQuestion(ctx);
  }

  // Если вопросов больше нет — подводим итоги
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

  // Сохраняем результаты и уведомляем
  const username = ctx.from.username || userId;
  await saveResults(username, s.answers, `${score}/${results.length}`);
  await bot.telegram.sendMessage(
    process.env.RESULTS_CHAT_ID,
    `Пользователь ${username} завершил опрос: ${score}/${results.length}`
  );
  delete sessions[userId];
});

(async () => {
  try {
    await authorize();
    await bot.launch();
    console.log('Бот запущен!');
  } catch (err) {
    console.error('Ошибка инициализации бота:', err);
  }
})();

