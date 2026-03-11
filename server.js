const express = require('express');
const cors = require('cors');
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

// ===== Skicka mötesinbjudningar (e-post + SMS) =====
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
      const respondUrl = `${BASE_URL}/mr?m=${meeting_id}`;

      // Skicka e-post
      if (user.email) {
        try {
          await resend.emails.send({
            from: 'LogiKarlskoga <info@gronfeltsgarden.se>',
            to: user.email,
            subject: `Mötesinbjudan: ${meeting.headline}`,
            html: `
              <div>
                <h2>${meeting.headline}</h2>
                ${meeting.content ? `<p>${meeting.content}</p>` : ''}
                <p>Datum: ${dateStr}</p>
                <p>Plats: ${meeting.place}</p>
                ${meeting.osa ? `<p>OSA senast: ${formatDateTime(meeting.osa)}</p>` : ''}
                ${meeting.created_by_name ? `<p>Inbjudan av: ${meeting.created_by_name}${meeting.created_by_company ? ', ' + meeting.created_by_company : ''}</p>` : ''}
                <p>
                  <a href="${respondUrl}">Svara på inbjudan</a>
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

      // Skicka SMS
      const phone = formatPhone(user.mobile);
      if (phone) {
        try {
          const smsText = `${meeting.headline}\n${dateStr}\nPlats: ${meeting.place}\n\nSvara: ${respondUrl}`;

          const params = new URLSearchParams({
            username: CELLSYNT_USERNAME,
            password: CELLSYNT_PASSWORD,
            destination: phone,
            originatortype: 'alpha',
            originator: 'LogiKarlsk',
            type: 'text',
            allowconcat: '6',
            charset: 'UTF-8',
            text: smsText,
          });

          const response = await fetch('https://se-1.cellsynt.net/sms.php?' + params.toString());
          const result = await response.text();
          console.log(`Cellsynt svar för ${phone}: ${result}`);

          if (result.startsWith('OK')) {
            smsCount++;
          } else {
            console.error(`SMS-fel: ${result}`);
          }
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
          from: 'LogiKarlskoga <info@gronfeltsgarden.se>',
          to: email,
          subject: 'Inbjudan till LogiKarlskoga',
          html: `
            <div>
              <h2>Välkommen till LogiKarlskoga!</h2>
              <p>${message.replace(/\n/g, '<br>')}</p>
              <p>
                <a href="${BASE_URL}/register">Registrera dig här</a>
              </p>
              <p>
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

    const params = new URLSearchParams({
      username: CELLSYNT_USERNAME,
      password: CELLSYNT_PASSWORD,
      destination: phone,
      originatortype: 'alpha',
      originator: 'LogiKarlsk',
      type: 'text',
      allowconcat: '6',
      charset: 'UTF-8',
      text: message,
    });

    const response = await fetch('https://se-1.cellsynt.net/sms.php?' + params.toString());
    const result = await response.text();
    console.log(`SMS till ${phone}: ${result}`);

    if (result.startsWith('OK')) {
      res.json({ success: true, result });
    } else {
      res.status(400).json({ error: result });
    }
  } catch (err) {
    console.error('SMS error:', err);
    res.status(500).json({ error: 'Internt serverfel' });
  }
});

// ===== Mejl vid borttagning av medlem =====
app.post('/api/member-removed', async (req, res) => {
  try {
    const { email, name, company } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email krävs' });
    }

    await resend.emails.send({
      from: 'LogiKarlskoga <info@gronfeltsgarden.se>',
      to: email,
      subject: 'Du har tagits bort från LogiKarlskoga',
      html: `
        <div>
          <h2>Hej ${name || ''},</h2>
          <p>Vi vill informera dig om att du har tagits bort från medlemsregistret i LogiKarlskoga.</p>
          <p>Om du har frågor, kontakta oss genom att svara på detta mejl.</p>
          <p>Med vänliga hälsningar,<br/>LogiKarlskoga</p>
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

    if (!emails?.length || !subject || !message) {
      return res.status(400).json({ error: 'Saknar obligatoriska fält' });
    }

    const results = await Promise.allSettled(
      emails.map((email) =>
        resend.emails.send({
          from: 'LogiKarlskoga <info@gronfeltsgarden.se>',
          to: email,
          subject: subject,
          text: message,
        })
      )
    );

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    res.json({ count: sent });
  } catch (err) {
    console.error('meeting-invite-external error:', err);
    res.status(500).json({ error: 'Kunde inte skicka inbjudan' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'LogiKarlskoga API' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server körs på port ${PORT}`);
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
          from: 'LogiKarlskoga <info@gronfeltsgarden.se>',
          to: email,
          subject: `Inställt möte: ${headline}`,
          html: `
            <div>
              <h2>Hej ${name || ''},</h2>
              <p>Mötet <strong>${headline}</strong> har ställts in.</p>
              <p><strong>Datum:</strong> ${dateStr}</p>
              <p><strong>Plats:</strong> ${place}</p>
              <p>Kontakta arrangören om du har frågor.</p>
              <p>Med vänliga hälsningar,<br/>LogiKarlskoga</p>
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
app.post('/api/meeting-updated', async (req, res) => {
  const { recipients, headline, oldDate, newDate, place } = req.body;
  const { format } = require('date-fns');
  const { sv } = require('date-fns/locale');
  
  const newFormatted = format(new Date(newDate), "d MMMM yyyy 'kl' HH:mm", { locale: sv });
  
  for (const r of recipients) {
    // Skicka mejl via Resend
    await resend.emails.send({
      from: 'LogiKarlskoga <no-reply@gronfeltsgarden.se>',
      to: r.email,
      subject: `Ändrad tid: ${headline}`,
      html: `<p>Hej ${r.name},</p><p>Mötet <strong>${headline}</strong> har fått ny tid: <strong>${newFormatted}</strong>, ${place}.</p>`,
    });

    // Skicka SMS om mobilnummer finns
    if (r.mobile) {
      // Skicka via Cellsynt med ert befintliga mönster
      // "Mötet {headline} har ändrats till {newFormatted}, {place}"
    }
  }
  
  res.json({ success: true });
});

