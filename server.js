const express = require('express');
const cors = require('cors');
const https = require('https');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BASE_URL = 'https://logikarl-magic-buddy.lovable.app';
const CELLSYNT_USERNAME = process.env.CELLSYNT_USERNAME;
const CELLSYNT_PASSWORD = process.env.CELLSYNT_PASSWORD;

function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString('sv-SE', {
    timeZone: 'Europe/Stockholm',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPhone(mobile) {
  if (!mobile) return null;
  let num = mobile.replace(/[\s\-]/g, '');
  if (num.startsWith('+46')) {
    num = '46' + num.slice(3);
  } else if (num.startsWith('0')) {
    num = '46' + num.slice(1);
  }
  if (/^46\d{7,10}$/.test(num)) {
    return num;
  }
  return null;
}

async function sendSms(phone, text) {
  const params = new URLSearchParams({
    username: CELLSYNT_USERNAME,
    password: CELLSYNT_PASSWORD,
    destination: phone,
    originatortype: 'alpha',
    originator: 'LogiKarlsk',
    type: 'text',
    allowconcat: '6',
    charset: 'UTF-8',
    text,
  });

  const response = await fetch('https://se-1.cellsynt.net/sms.php?' + params.toString());
  const result = await response.text();
  console.log(`Cellsynt svar för ${phone}: ${result}`);
  return result.startsWith('OK');
}

// ===== Ta emot inkommande mejl via Resend webhook =====
app.post('/api/inbound-email', async (req, res) => {
  try {
    const payload = req.body;

    const from = payload.from || '';
    const to = payload.to || '';
    const subject = payload.subject || '(Inget ämne)';
    const html = payload.html || '';
    const text = payload.text || '';
    const createdAt = payload.created_at || new Date().toISOString();

    const { error } = await supabase
      .from('inbound_emails')
      .insert({
        from_address: from,
        to_address: to,
        subject,
        html_body: html,
        text_body: text,
        received_at: createdAt,
      });

    if (error) {
      console.error('Kunde inte spara inkommande mejl:', error);
      return res.status(500).json({ error: 'Kunde inte spara mejl' });
    }

    console.log(`Inkommande mejl sparat från ${from}: ${subject}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Inbound email error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Hämta inkommande mejl (för superadmin) =====
app.get('/api/inbound-emails', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inbound_emails')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Kunde inte hämta mejl:', error);
      return res.status(500).json({ error: 'Kunde inte hämta mejl' });
    }

    res.json({ emails: data });
  } catch (err) {
    console.error('Get inbound emails error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Skicka mötesinbjudningar till medlemmar (e-post + SMS) =====
app.post('/api/meeting-invites', async (req, res) => {
  try {
    const { meeting_id, invitee_ids } = req.body;

    if (!meeting_id || !invitee_ids || invitee_ids.length === 0) {
      return res.status(400).json({ error: 'meeting_id och invitee_ids krävs' });
    }

    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', meeting_id)
      .single();

    if (meetingError || !meeting) {
      return res.status(404).json({ error: 'Mötet hittades inte' });
    }

    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('*')
      .in('id', invitee_ids);

    if (usersError || !users || users.length === 0) {
      return res.status(404).json({ error: 'Inga användare hittades' });
    }

    const dateStr = formatDateTime(meeting.date);
    let emailCount = 0;
    let smsCount = 0;

    for (const user of users) {
      const respondUrl = `${BASE_URL}/mr?m=${meeting_id}&email=${encodeURIComponent(user.email)}`;

      if (user.email) {
        try {
          await resend.emails.send({
            from: 'LogiKarlskoga <info@logikarlskoga.se>',
            to: user.email,
            subject: `Mötesinbjudan: ${meeting.headline}`,
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
                <h2>${meeting.headline}</h2>
                ${meeting.content ? `<p>${meeting.content}</p>` : ''}
                <p>Datum: ${dateStr}</p>
                <p>Plats: ${meeting.place}</p>
                ${meeting.osa ? `<p>OSA senast: ${formatDateTime(meeting.osa)}</p>` : ''}
                ${meeting.created_by_name ? `<p>Inbjudan av: ${meeting.created_by_name}${meeting.created_by_company ? ', ' + meeting.created_by_company : ''}</p>` : ''}
                <p style="margin-top:24px">
                  <a href="${respondUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Svara på inbjudan</a>
                </p>
              </div>
            `,
          });
          emailCount++;
          console.log(`E-post skickat till ${user.email}`);
        } catch (err) {
          console.error(`E-postfel till ${user.email}:`, err.message);
        }
      }

      const phone = formatPhone(user.mobile);
      if (phone) {
        try {
          const smsText = `${meeting.headline}\n${dateStr}\nPlats: ${meeting.place}\n\nSvara: ${respondUrl}`;
          const ok = await sendSms(phone, smsText);
          if (ok) smsCount++;
        } catch (err) {
          console.error(`SMS-fel till ${phone}:`, err.message);
        }
      }
    }

    console.log(`Totalt: ${emailCount} e-post, ${smsCount} SMS skickade`);
    res.json({ success: true, emailCount, smsCount });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Bjud in nya medlemmar via e-post =====
app.post('/api/invite', async (req, res) => {
  try {
    const { emails, message } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Inga e-postadresser angivna' });
    }

    let successCount = 0;

    for (const email of emails) {
      try {
        await resend.emails.send({
          from: 'LogiKarlskoga <info@logikarlskoga.se>',
          to: email,
          subject: 'Inbjudan till LogiKarlskoga',
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
              <h2>Välkommen till LogiKarlskoga!</h2>
              <p>${message.replace(/\n/g, '<br>')}</p>
              <p style="margin-top:24px">
                <a href="${BASE_URL}/register" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Registrera dig här</a>
              </p>
              <p style="margin-top:24px;font-size:12px;color:#888">
                Detta mejl skickades via LogiKarlskoga
              </p>
            </div>
          `,
        });
        successCount++;
        console.log(`Inbjudan skickad till ${email}`);
      } catch (err) {
        console.error(`Kunde inte skicka till ${email}:`, err.message);
      }
    }

    res.json({ success: true, count: successCount });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Skicka manuellt SMS =====
app.post('/api/send-sms', async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'to och message krävs' });
    }

    const phone = formatPhone(to);
    if (!phone) {
      return res.status(400).json({ error: 'Ogiltigt telefonnummer' });
    }

    const ok = await sendSms(phone, message);
    if (ok) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'SMS kunde inte skickas' });
    }
  } catch (err) {
    console.error('SMS error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Mejl vid borttagning av medlem =====
app.post('/api/member-removed', async (req, res) => {
  try {
    const { email, name } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email krävs' });
    }

    await resend.emails.send({
      from: 'LogiKarlskoga <info@logikarlskoga.se>',
      to: email,
      subject: 'Du har tagits bort från LogiKarlskoga',
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
          <p>Hej ${name || ''},</p>
          <p>Vi vill informera dig om att du har tagits bort från medlemsregistret i LogiKarlskoga.</p>
          <p>Om du har frågor, kontakta oss genom att svara på detta mejl.</p>
          <p>Med vänliga hälsningar,<br>LogiKarlskoga</p>
        </div>
      `,
    });

    console.log(`Removal email sent to ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Member removal email error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Skicka mötesinbjudan till externa gäster =====
app.post('/api/meeting-invite-external', async (req, res) => {
  try {
    const { emails, meeting_id, message, subject } = req.body;

    if (!emails?.length || !meeting_id) {
      return res.status(400).json({ error: 'Saknar obligatoriska fält' });
    }

    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', meeting_id)
      .single();

    if (meetingError || !meeting) {
      return res.status(404).json({ error: 'Mötet hittades inte' });
    }

    const dateStr = formatDateTime(meeting.date);
    let sent = 0;

    for (const email of emails) {
      try {
        const respondUrl = `${BASE_URL}/mr?m=${meeting_id}&email=${encodeURIComponent(email)}`;

        await resend.emails.send({
          from: 'LogiKarlskoga <info@logikarlskoga.se>',
          to: email,
          subject: subject || `Mötesinbjudan: ${meeting.headline}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
              <h2>${meeting.headline}</h2>
              ${meeting.content ? `<p>${meeting.content}</p>` : ''}
              <p>Datum: ${dateStr}</p>
              <p>Plats: ${meeting.place}</p>
              ${meeting.osa ? `<p>OSA senast: ${formatDateTime(meeting.osa)}</p>` : ''}
              ${meeting.created_by_name ? `<p>Inbjudan av: ${meeting.created_by_name}${meeting.created_by_company ? ', ' + meeting.created_by_company : ''}</p>` : ''}
              ${message ? `<p>${message.replace(/\n/g, '<br>')}</p>` : ''}
              <p style="margin-top:24px">
                <a href="${respondUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Svara på inbjudan</a>
              </p>
              <p style="margin-top:24px;font-size:12px;color:#888">
                Detta mejl skickades via LogiKarlskoga
              </p>
            </div>
          `,
        });
        sent++;
        console.log(`Extern inbjudan skickad till ${email}`);
      } catch (err) {
        console.error(`Extern inbjudan fel till ${email}:`, err.message);
      }
    }

    res.json({ count: sent });
  } catch (err) {
    console.error('meeting-invite-external error:', err);
    res.status(500).json({ error: 'Kunde inte skicka inbjudan' });
  }
});

// ===== Externt mötessvar (gäster utan konto) =====
app.post('/api/meeting-response-external', async (req, res) => {
  try {
    const { meeting_id, email, status, name, company, mobile } = req.body;

    if (!meeting_id || !email || !status) {
      return res.status(400).json({ error: 'meeting_id, email och status krävs' });
    }

    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', meeting_id)
      .single();

    if (meetingError || !meeting) {
      return res.status(404).json({ error: 'Mötet hittades inte' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    let { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    let userId;

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          email: normalizedEmail,
          name: name || '',
          company: company || '',
          mobile: mobile || '',
        })
        .select('id')
        .single();

      if (createError) {
        console.error('Kunde inte skapa användare:', createError);
        return res.status(500).json({ error: 'Kunde inte skapa användare' });
      }
      userId = newUser.id;
    }

    const { error: upsertError } = await supabase
      .from('meeting_responses')
      .upsert(
        {
          meeting_id,
          user_id: userId,
          status,
          responded_at: new Date().toISOString(),
          invited_at: new Date().toISOString(),
        },
        { onConflict: 'meeting_id,user_id' }
      );

    if (upsertError) {
      console.error('Kunde inte spara svar:', upsertError);
      return res.status(500).json({ error: 'Kunde inte spara svar' });
    }

    if (status === 'accepted') {
      const dateStr = formatDateTime(meeting.date);
      try {
        await resend.emails.send({
          from: 'LogiKarlskoga <info@logikarlskoga.se>',
          to: normalizedEmail,
          subject: `Bekräftelse: ${meeting.headline}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
              <h2>Tack för ditt svar!</h2>
              <p>Du har tackat ja till mötet ${meeting.headline}.</p>
              <p>Datum: ${dateStr}</p>
              <p>Plats: ${meeting.place}</p>
              ${meeting.created_by_name ? `<p>Inbjudan av: ${meeting.created_by_name}${meeting.created_by_company ? ', ' + meeting.created_by_company : ''}</p>` : ''}
              <p>Välkommen!</p>
              <p style="margin-top:24px;font-size:12px;color:#888">Detta mejl skickades via LogiKarlskoga</p>
            </div>
          `,
        });
        console.log(`Bekräftelsemejl skickat till ${normalizedEmail}`);
      } catch (err) {
        console.error('Bekräftelsemejl fel:', err.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('meeting-response-external error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Mejl vid inställt möte =====
app.post('/api/meeting-cancelled', async (req, res) => {
  try {
    const { emails, headline, date, place } = req.body;

    if (!emails || emails.length === 0) {
      return res.status(400).json({ error: 'Inga mottagare' });
    }

    const dateStr = formatDateTime(date);
    let count = 0;

    for (const { email, name } of emails) {
      try {
        await resend.emails.send({
          from: 'LogiKarlskoga <info@logikarlskoga.se>',
          to: email,
          subject: `Inställt möte: ${headline}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
              <p>Hej ${name || ''},</p>
              <p>Mötet ${headline} har ställts in.</p>
              <p>Datum: ${dateStr}</p>
              <p>Plats: ${place}</p>
              <p>Kontakta arrangören om du har frågor.</p>
              <p>Med vänliga hälsningar,<br>LogiKarlskoga</p>
            </div>
          `,
        });
        count++;
      } catch (err) {
        console.error(`Cancellation email error for ${email}:`, err.message);
      }
    }

    res.json({ success: true, count });
  } catch (err) {
    console.error('Meeting cancelled error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Mejl + SMS vid ändrat möte =====
app.post('/api/meeting-updated', async (req, res) => {
  try {
    const { recipients, headline, newDate, place } = req.body;

    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Inga mottagare' });
    }

    const newFormatted = formatDateTime(newDate);
    let emailCount = 0;
    let smsCount = 0;

    for (const r of recipients) {
      if (r.email) {
        try {
          await resend.emails.send({
            from: 'LogiKarlskoga <info@logikarlskoga.se>',
            to: r.email,
            subject: `Ändrat möte: ${headline}`,
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
                <p>Hej ${r.name || ''},</p>
                <p>Mötet ${headline} har uppdaterats.</p>
                <p>Datum: ${newFormatted}</p>
                <p>Plats: ${place}</p>
                <p>Med vänliga hälsningar,<br>LogiKarlskoga</p>
              </div>
            `,
          });
          emailCount++;
        } catch (err) {
          console.error(`Update email error for ${r.email}:`, err.message);
        }
      }

      const phone = formatPhone(r.mobile);
      if (phone) {
        try {
          const smsText = `Ändrat möte: ${headline}\nDatum: ${newFormatted}\nPlats: ${place}`;
          const ok = await sendSms(phone, smsText);
          if (ok) smsCount++;
        } catch (err) {
          console.error(`Update SMS error for ${phone}:`, err.message);
        }
      }
    }

    console.log(`Meeting updated: ${emailCount} mejl, ${smsCount} SMS`);
    res.json({ success: true, emailCount, smsCount });
  } catch (err) {
    console.error('Meeting updated error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Mejl vid borttagning av deltagare från möte =====
app.post('/api/attendee-removed', async (req, res) => {
  try {
    const { email, name, headline, date, place } = req.body;

    if (!email || !headline) {
      return res.status(400).json({ error: 'email och headline krävs' });
    }

    const dateStr = formatDateTime(date);

    await resend.emails.send({
      from: 'LogiKarlskoga <info@logikarlskoga.se>',
      to: email,
      subject: `Du har tagits bort från mötet: ${headline}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
          <p>Hej ${name || ''},</p>
          <p>Du har tagits bort från mötet ${headline}.</p>
          <p>Datum: ${dateStr}</p>
          <p>Plats: ${place}</p>
          <p>Kontakta arrangören om du har frågor.</p>
          <p>Med vänliga hälsningar,<br>LogiKarlskoga</p>
        </div>
      `,
    });

    console.log(`Attendee removal email sent to ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Attendee removed email error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Påminnelse dagen innan möte =====
async function sendMeetingReminders() {
  const now = new Date();
  const swedenNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Stockholm' }));
  const tomorrow = new Date(swedenNow);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const tomorrowStart = new Date(tomorrow);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setHours(23, 59, 59, 999);

  const { data: meetings, error: meetingsError } = await supabase
    .from('meetings')
    .select('*')
    .gte('date', tomorrowStart.toISOString())
    .lte('date', tomorrowEnd.toISOString());

  if (meetingsError) throw meetingsError;
  if (!meetings || meetings.length === 0) {
    return { sent: 0, meetings: 0, message: 'Inga möten imorgon.' };
  }

  let totalSent = 0;

  for (const meeting of meetings) {
    const { data: responses } = await supabase
      .from('meeting_responses')
      .select('user_id')
      .eq('meeting_id', meeting.id)
      .eq('status', 'accepted');

    if (!responses || responses.length === 0) continue;

    const userIds = responses.map((r) => r.user_id);
    const { data: users } = await supabase
      .from('users')
      .select('email, name')
      .in('id', userIds);

    if (!users || users.length === 0) continue;

    const dateStr = formatDateTime(meeting.date);

    for (const user of users) {
      if (!user.email) continue;
      try {
        await resend.emails.send({
          from: 'LogiKarlskoga <info@logikarlskoga.se>',
          to: user.email,
          subject: `Påminnelse imorgon: ${meeting.headline}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
              <h2>Påminnelse!</h2>
              <p>Hej ${user.name || ''},</p>
              <p>Imorgon har du mötet ${meeting.headline}.</p>
              <p>Datum: ${dateStr}</p>
              <p>Plats: ${meeting.place}</p>
              ${meeting.created_by_name ? `<p>Arrangör: ${meeting.created_by_name}${meeting.created_by_company ? ', ' + meeting.created_by_company : ''}</p>` : ''}
              <p>Välkommen!</p>
              <p style="margin-top:24px;font-size:12px;color:#888">Detta mejl skickades via LogiKarlskoga</p>
            </div>
          `,
        });
        totalSent++;
        console.log(`Påminnelse skickad till ${user.email} för ${meeting.headline}`);
      } catch (err) {
        console.error(`Påminnelse-mejl fel till ${user.email}:`, err.message);
      }
    }
  }

  return { sent: totalSent, meetings: meetings.length };
}

app.get('/api/send-reminders', async (req, res) => {
  try {
    const result = await sendMeetingReminders();
    console.log('Påminnelser resultat:', result);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('send-reminders error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Proxy för SCB:s API (CORS) =====
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload ?? {});

    const req = https.request(
      {
        method: 'POST',
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode || 500, data });
        });
      }
    );
    
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Timeout mot SCB API'));
    });

    req.write(body);
    req.end();
  });
}

app.post('/api/scb-proxy', async (req, res) => {
  try {
    const { status, data } = await postJson(
      'https://api.scb.se/OV0104/v1/doris/sv/ssd/START/NV/NV1101/NV1101B/NV1101B01',
      req.body
    );

    if (status < 200 || status >= 300) {
      console.error('SCB API error:', status, data);
      return res.status(status).json({ error: data });
    }

    const json = JSON.parse(data);
    return res.json(json);
  } catch (err) {
    console.error('SCB proxy error:', err);
    return res.status(500).json({ error: `Kunde inte hämta data: ${err.message}` });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'LogiKarlskoga API' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server körs på port ${PORT}`);
});
