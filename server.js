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

app.post('/api/meeting-invites', async (req, res) => {
  const { meeting_id, invitee_ids } = req.body;

  const { data: meeting } = await supabase
    .from('meetings').select('*').eq('id', meeting_id).single();
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  const { data: users } = await supabase
    .from('users').select('*').in('id', invitee_ids);

  for (const user of users || []) {
    const acceptUrl = `${APP_URL}/meeting-response?meeting=${meeting_id}&user=${user.id}&action=accept`;
    const declineUrl = `${APP_URL}/meeting-response?meeting=${meeting_id}&user=${user.id}&action=decline`;

    try {
      await resend.emails.send({
        from: 'LogiKarlskoga <noreply@din-doman.se>',
        to: user.email,
        subject: `Mötesinbjudan: ${meeting.headline}`,
        html: `
          <h2>${meeting.headline}</h2>
          <p>${meeting.content || ''}</p>
          <p><strong>Datum:</strong> ${new Date(meeting.date).toLocaleString('sv-SE')}</p>
          <p><strong>Plats:</strong> ${meeting.place}</p>
          <br/>
          <a href="${acceptUrl}" style="background:#2d6a4f;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;margin-right:8px;">Tacka ja</a>
          <a href="${declineUrl}" style="background:#6b7280;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;">Tacka nej</a>
        `,
      });
    } catch (err) {
      console.error('Resend error:', err);
    }

    if (user.mobile) {
      try {
        const params = new URLSearchParams({
          username: process.env.CELLSYNT_USERNAME,
          password: process.env.CELLSYNT_PASSWORD,
          destination: user.mobile.replace(/[^0-9+]/g, ''),
          originatortype: 'alpha',
          originator: 'LogiKarlskoga',
          type: 'text',
          text: `Mötesinbjudan: ${meeting.headline}, ${new Date(meeting.date).toLocaleString('sv-SE')}. Svara här: ${acceptUrl}`,
        });
        await fetch(`https://se-1.cellsynt.net/sms.php?${params}`);
      } catch (err) {
        console.error('Cellsynt error:', err);
      }
    }
  }

  res.json({ success: true, sent: (users || []).length });
});

app.listen(3000, () => console.log('API running on port 3000'));
