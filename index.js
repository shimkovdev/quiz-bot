require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// Конфигурация из .env
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

async function loadQuiz() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
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

bot.start(ctx => ctx.reply('Привет! Готов пройти опрос?', Markup.inlineKeyboard([
  Markup.button.callback('Начать опрос', 'START')
])));

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
  const { id } = ctx.from;
  const session = sessions[id];
  session.answers.push(ctx.match[1]);
  session.index++;
  if (session.index < session.quiz.length) return sendQuestion(ctx);

  // Подведение итогов
  const res = session.quiz.map((q, i) => ({
    question: q.text,
    answer: session.answers[i],
    correct: q.correct,
  }));
  const score = res.filter(x => x.answer === x.correct).length;
  const summary = res.map(x =>
    `❓ ${x.question}\n✅ ${x.correct}\n📝 ${x.answer}`
  ).join('\n\n') +
    `\n\n🎉 Правильно: ${score}/${res.length}`;

  await ctx.editMessageText(summary);

  // Запись результатов в Google Sheet
  const sheetR = doc.sheetsByTitle['Опрос'];
  await sheetR.addRow([
    ctx.from.username || id,
    ...session.answers,
    `${score}/${res.length}`
  ]);

  // Уведомление владельца
  await bot.telegram.sendMessage(process.env.RESULTS_CHAT_ID,
    `Пользователь ${ctx.from.username} завершил опрос: ${score}/${res.length}`
  );
  delete sessions[id];
});

bot.launch();