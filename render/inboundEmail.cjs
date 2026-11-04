const { Webhook } = require('svix');

function createInboundHandlers({ supabase, apiKey, webhookSecret, fetchEmail = fetch }) {
  return {
    async receive(req, res) {
      if (!webhookSecret || !apiKey) return res.status(503).json({ error: 'Mejlmottagningen saknar inställningar' });
      let event;
      try {
        new Webhook(webhookSecret).verify(req.body, {
          'svix-id': req.headers['svix-id'],
          'svix-timestamp': req.headers['svix-timestamp'],
          'svix-signature': req.headers['svix-signature'],
        });
        event = JSON.parse(req.body.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Ogiltig webhooksignatur' });
      }
      if (event.type !== 'email.received') return res.json({ ignored: true });
      const emailId = event.data?.email_id;
      if (typeof emailId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(emailId)) {
        return res.status(400).json({ error: 'Mejlets id saknas eller är ogiltigt' });
      }
      try {
        const response = await fetchEmail(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          console.error('Kunde inte hämta inkommande mejl från Resend:', response.status);
          return res.status(502).json({ error: 'Resend kunde inte lämna ut mejltexten', status: response.status });
        }
        const email = await response.json();
        const { error } = await supabase.from('inbound_emails').insert({
          from_address: email.from || event.data.from || '',
          to_address: Array.isArray(email.to) ? email.to.join(', ') : (email.to || ''),
          subject: email.subject || '(Inget ämne)',
          html_body: email.html || '',
          text_body: email.text || '',
          received_at: email.created_at || event.created_at || new Date().toISOString(),
          is_read: false,
        });
        if (error) return res.status(500).json({ error: 'Kunde inte spara mejl externt' });
        return res.json({ success: true });
      } catch {
        return res.status(502).json({ error: 'Kunde inte hämta eller spara inkommande mejl' });
      }
    },
    async list(req, res) {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) return res.status(401).json({ error: 'Logga in för att läsa inkorgen' });
      try {
        const { data: auth, error: authError } = await supabase.auth.getUser(token);
        if (authError || !auth?.user) return res.status(401).json({ error: 'Inloggningen är ogiltig' });
        const { data: role, error: roleError } = await supabase.from('user_roles')
          .select('role').eq('user_id', auth.user.id).eq('role', 'superadmin').maybeSingle();
        if (roleError || !role) return res.status(403).json({ error: 'Inkorgen är endast tillgänglig för superadmin' });
        const { data, error } = await supabase.from('inbound_emails').select('*')
          .order('received_at', { ascending: false }).limit(50);
        if (error) return res.status(500).json({ error: 'Kunde inte hämta mejl' });
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ emails: data });
      } catch {
        return res.status(500).json({ error: 'Kunde inte hämta inkorgen' });
      }
    },
  };
}
module.exports = { createInboundHandlers };