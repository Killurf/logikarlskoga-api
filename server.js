const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const APP_URL = process.env.APP_URL;

function formatDateTime(isoString) {
  const d = new Date(isoString);
  const date = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const time = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
  return `${date} kl ${time}`;
}

app.post('/api/meeting-invites', async (req, res) => {
  const { meeting_id, invitee_ids } = req.body;

  const { data: meeting } = await supabase
    .from('meetings').select('*').eq('id', meeting_id).single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  const { data: users } = await supabase
    .from('users').select('*').in('id', invitee_ids);

  const inviterInfo = meeting.created_by_name + (meeting.created_by_company ? `, ${meeting.created_by_company}` : '');
  const dateTime = formatDateTime(meeting.date);

  let emailsSent = 0;
  let smsSent = 0;

  for (const user of users || []) {
    const acceptUrl = `${APP_URL}/mr?m=${meeting_id}&u=${user.id}&a=accept`;
    const declineUrl = `${APP_URL}/mr?m=${meeting_id}&u=${user.id}&a=decline`;

    if (user.email) {
      try {
        await resend.emails.send({
          from: 'LogiKarlskoga <noreply@gronfeltsgarden.se>',
          to: user.email,
          subject: `Mötesinbjudan: ${meeting.headline}`,
          html: `
            <h2>${meeting.headline}</h2>
            <p><strong>Inbjudan från:</strong> ${inviterInfo}</p>
            ${meeting.content ? `<p>${meeting.content}</p>` : ''}
            <p><strong>Datum:</strong> ${dateTime}</p>
            <p><strong>Plats:</strong> ${meeting.place}</p>
            <br>
            <a href="${acceptUrl}" style="background:#16a34a;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;margin-right:12px;">Tacka ja</a>
            <a href="${declineUrl}" style="background:#dc2626;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;">Tacka nej</a>
          `,
        });
        emailsSent++;
        console.log(`E-post skickad till ${user.email}`);
      } catch (err) {
        console.error(`Resend error för ${user.email}:`, err);
      }
    }

    if (user.mobile) {
      try {
        const formattedNumber = user.mobile.replace(/[^0-9]/g, '').replace(/^0/, '46');
        const smsText = `${meeting.headline}, ${dateTime}. Svara: ${acceptUrl}`;
        const params = new URLSearchParams({
          username: process.env.CELLSYNT_USERNAME,
          password: process.env.CELLSYNT_PASSWORD,
          destination: formattedNumber,
          originatortype: 'alpha',
          originator: 'LogiKarlsk',
          type: 'text',
          allowconcat: '6',
          charset: 'UTF-8',
          text: smsText,
        });
        const smsResponse = await fetch(`https://se-1.cellsynt.net/sms.php?${params}`);
        const smsResult = await smsResponse.text();
        console.log(`Cellsynt svar för ${formattedNumber}: ${smsResult}`);
        if (smsResult.includes('Error')) {
          console.error(`SMS-fel: ${smsResult}`);
        } else {
          smsSent++;
        }
      } catch (err) {
        console.error(`Cellsynt error för ${user.mobile}:`, err);
      }
    }
  }

  console.log(`Totalt: ${emailsSent} e-post, ${smsSent} SMS skickade`);
  res.json({ success: true, sent: (users || []).length, emailsSent, smsSent });
});

app.post('/api/send-sms', async (req, res) => {
  const { recipient_user_id, message, sender_name, sender_company } = req.body;

  const { data: recipient } = await supabase
    .from('users').select('mobile, name').eq('id', recipient_user_id).single();

  if (!recipient || !recipient.mobile) {
    return res.status(400).json({ error: 'Mottagaren har inget mobilnummer registrerat.' });
  }

  const senderInfo = sender_name + (sender_company ? `, ${sender_company}` : '');
  const fullText = `Från ${senderInfo}: ${message}`;

  try {
    const formattedNumber = recipient.mobile.replace(/[^0-9]/g, '').replace(/^0/, '46');
    const params = new URLSearchParams({
      username: process.env.CELLSYNT_USERNAME,
      password: process.env.CELLSYNT_PASSWORD,
      destination: formattedNumber,
      originatortype: 'alpha',
      originator: 'LogiKarlsk',
      type: 'text',
      charset: 'UTF-8',
      text: fullText,
    });
    const smsResponse = await fetch(`https://se-1.cellsynt.net/sms.php?${params}`);
    const smsResult = await smsResponse.text();
    console.log(`SMS till ${formattedNumber}: ${smsResult}`);
    res.json({ success: true });
  } catch (err) {
    console.error('SMS error:', err);
    res.status(500).json({ error: 'Kunde inte skicka SMS' });
  }
});

app.listen(3000, () => console.log('API running on port 3000'));
