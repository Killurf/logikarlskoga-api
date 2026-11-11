// Manual reminders use the external database for authorization and recipient lookup.
function createManualReminderHandler({ supabase, resend }) {
  return async (req, res) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'Logga in för att skicka påminnelser.' });
      const { data: auth, error: authError } = await supabase.auth.getUser(token);
      if (authError || !auth?.user) return res.status(401).json({ error: 'Logga in igen för att skicka påminnelser.' });
      const { meeting_id, recipients, type } = req.body || {};
      if (type !== 'email' || !meeting_id || !Array.isArray(recipients) || !recipients.length) {
        return res.status(400).json({ error: 'Möte och mejlmottagare krävs.' });
      }
      const { data: meeting, error: meetingError } = await supabase.from('meetings').select('*').eq('id', meeting_id).single();
      if (meetingError || !meeting) return res.status(404).json({ error: 'Mötet hittades inte.' });
      if (meeting.created_by !== auth.user.id) {
        const { data: role, error: roleError } = await supabase.from('user_roles').select('role').eq('user_id', auth.user.id).eq('role', 'superadmin').maybeSingle();
        if (roleError || !role) return res.status(403).json({ error: 'Endast mötesansvarig och superadmin får skicka påminnelser.' });
      }
      if (new Date(meeting.date) < new Date()) return res.status(400).json({ error: 'Påminnelser skickas inte för tidigare möten.' });
      const { data: responses, error: responseError } = await supabase.from('meeting_responses').select('user_id').eq('meeting_id', meeting_id);
      if (responseError) return res.status(500).json({ error: 'Kunde inte hämta mötets deltagare.' });
      const ids = (responses || []).map((r) => r.user_id).filter(Boolean);
      const { data: users, error: usersError } = ids.length
        ? await supabase.from('users').select('id, name, email').in('id', ids)
        : { data: [], error: null };
      if (usersError) return res.status(500).json({ error: 'Kunde inte hämta mottagarna.' });
      const allowed = new Map((users || []).filter((u) => u.email).map((u) => [u.email.trim().toLowerCase(), u]));
      const escape = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      const date = new Date(meeting.date).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const failures = [];
      let count = 0;
      for (const email of new Set(recipients.map((r) => String(r.email || '').trim().toLowerCase()))) {
        const user = allowed.get(email);
        if (!user) {
          failures.push({ email, error: 'Mottagaren finns inte bland mötets inbjudna.' });
          continue;
        }
        const responseUrl = `https://www.logikarlskoga.se/mr?m=${encodeURIComponent(meeting_id)}&email=${encodeURIComponent(user.email)}`;
        try {
          const { data, error } = await resend.emails.send({
            from: 'LogiKarlskoga <inbjudan@logikarlskoga.se>',
            to: user.email,
            subject: `Påminnelse: ${meeting.headline}`,
            html: `<div><h2>${escape(meeting.headline)}</h2><p>Hej ${escape(user.name)},</p><p>Vi påminner om vårt möte.</p><p><strong>Datum och tid:</strong> ${escape(date)}</p><p><strong>Plats:</strong> ${escape(meeting.place)}</p><p><a href="${escape(responseUrl)}">Svara på inbjudan</a></p><p>LogiKarlskoga</p></div>`,
          });
          if (error || !data?.id) {
            const reason = error?.message || 'Mejltjänsten bekräftade inte utskicket.';
            console.error('Manual reminder failed:', error?.statusCode || 502, reason);
            failures.push({ email, error: reason, status: error?.statusCode || 502 });
          } else count++;
        } catch (error) {
          failures.push({ email, error: error.message || 'Kunde inte nå mejltjänsten.' });
        }
      }
      return res.json({ success: failures.length === 0, count, failures });
    } catch (error) {
      console.error('Manual reminders failed:', error.message);
      return res.status(500).json({ error: 'Kunde inte skicka påminnelser.' });
    }
  };
}
module.exports = { createManualReminderHandler };