const MAX_SMS_LENGTH = 918;

function createSmsBroadcastHandler({ supabase, sendSms, formatPhone }) {
  return async function sendSmsBroadcast(req, res) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return res.status(401).json({ error: 'Logga in för att skicka SMS' });
    const { recipient_ids: ids, message } = req.body || {};
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) return res.status(400).json({ error: 'Skriv ett meddelande' });
    if (text.length > MAX_SMS_LENGTH) return res.status(400).json({ error: `Meddelandet får vara högst ${MAX_SMS_LENGTH} tecken` });
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((i) => typeof i === 'string')) {
      return res.status(400).json({ error: 'Välj mellan 1 och 500 mottagare' });
    }
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser(token);
      if (authError || !auth?.user) return res.status(401).json({ error: 'Inloggningen är ogiltig' });
      const { data: role } = await supabase.from('user_roles')
        .select('role').eq('user_id', auth.user.id).eq('role', 'superadmin').maybeSingle();
      if (!role) return res.status(403).json({ error: 'Endast superadmin kan skicka SMS' });
      const { data: users, error } = await supabase.from('users').select('id, name, mobile').in('id', ids);
      if (error) return res.status(500).json({ error: 'Kunde inte hämta mottagare' });
      let sent = 0;
      const failed = [];
      for (const u of users || []) {
        const phone = formatPhone(u.mobile);
        if (!phone) { failed.push({ name: u.name, reason: 'Saknar giltigt mobilnummer' }); continue; }
        let ok = false;
        try { ok = await sendSms(phone, text); } catch { ok = false; }
        if (ok) sent++; else failed.push({ name: u.name, reason: 'SMS-tjänsten tog inte emot meddelandet' });
      }
      return res.json({ sent, failed });
    } catch {
      return res.status(500).json({ error: 'Kunde inte skicka SMS' });
    }
  };
}
module.exports = { createSmsBroadcastHandler, MAX_SMS_LENGTH };
