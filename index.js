require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

console.log('google-spreadsheet version:', require('google-spreadsheet/package.json').version);


async function authorizeGoogleSheet() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
}

// Загрузка викторины
async function loadQuiz() {
  const sheetQ = doc.sheetsByTitle['Вопросы'];
  const rows = await sheetQ.getRows();

  const header = sheetQ.headerValues;
  const correctRow = rows[0];
  const optionRows = rows.slice(1);

  return header.map((q, i) => ({
    text: q,
    options: optionRows.map(r => r._rawData[i]).filter(o => o),
    correct: correctRow._rawData[i],
  }));
}

const sessions = {};

bot.start(ctx => {
  ctx.reply('Привет! Готов пройти опрос?', Markup.inlineKeyboard([
    Markup.button.callback('Начать опрос', 'START')
  ]));
});

bot.action('START', async ctx => {
  const quiz = await loadQuiz();
  sessions[ctx.from.id] = { quiz, index: 0, answers: [] };
  sendQuestion(ctx);
});

function sendQuestion(ctx) {
  const session = sessions[ctx.from.id];
  const q = session.quiz[session.index];
  ctx.editMessageText(q.text, Markup.inlineKeyboard(
    q.options.map(o => Markup.button.callback(o, `ANS_${o}`))
  ));
}

bot.action(/ANS_(.+)/, async ctx => {
  const id = ctx.from.id;
  const session = sessions[id];
  session.answers.push(ctx.match[1]);
  session.index++;

  if (session.index < session.quiz.length) {
    return sendQuestion(ctx);
  }

  const results = session.quiz.map((q, i) => ({
    question: q.text,
    correct: q.correct,
    answer: session.answers[i]
  }));

  const score = results.filter(r => r.answer === r.correct).length;
  const summary = results.map(r =>
    `❓ ${r.question}\n✅ ${r.correct}\n📝 ${r.answer}`
  ).join('\n\n') + `\n\n🎉 Вы ответили правильно на ${score} из ${results.length}`;

  await ctx.editMessageText(summary);

  const sheetR = doc.sheetsByTitle['Опрос'];
  await sheetR.addRow({
    'Пользователь': ctx.from.username || id,
    ...session.answers.reduce((acc, ans, idx) => {
      acc[`Ответ ${idx + 1}`] = ans;
      return acc;
    }, {}),
    'Результат': `${score}/${results.length}`
  });

  await bot.telegram.sendMessage(
    process.env.RESULTS_CHAT_ID,
    `Пользователь ${ctx.from.username || id} завершил опрос: ${score}/${results.length}`
  );

  delete sessions[id];
});

(async () => {
  try {
    await authorizeGoogleSheet();
    await bot.launch();
    console.log('Бот запущен!');
  } catch (err) {
    console.error('Ошибка инициализации бота:', err);
  }
})();

