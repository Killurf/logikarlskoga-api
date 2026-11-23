const FROM = 'LogiKarlskoga <noreply@logikarlskoga.se>';
const SITE = 'https://www.logikarlskoga.se';
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paras = (s) => esc(s).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

function createForumNotifyHandler({ supabase, resend }) {
  return async function forumNotify(req, res) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return res.status(401).json({ error: 'Logga in' });
    const { post_id: postId, comment_id: commentId } = req.body || {};
    if (typeof postId !== 'string' || typeof commentId !== 'string') return res.status(400).json({ error: 'Ogiltig begäran' });
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser(token);
      if (authError || !auth?.user) return res.status(401).json({ error: 'Inloggningen är ogiltig' });
      const { data: comment } = await supabase.from('forum_comments')
        .select('id, post_id, author_id, body').eq('id', commentId).maybeSingle();
      if (!comment || comment.post_id !== postId || comment.author_id !== auth.user.id) {
        return res.status(403).json({ error: 'Ej behörig' });
      }
      const { data: post } = await supabase.from('forum_posts').select('id, title').eq('id', postId).maybeSingle();
      if (!post) return res.status(404).json({ error: 'Inlägget finns inte' });
      const { data: follows } = await supabase.from('forum_follows').select('user_id').eq('post_id', postId);
      const ids = [...new Set((follows || []).map((f) => f.user_id))].filter((id) => id !== auth.user.id);
      const { data: author } = await supabase.from('users').select('name').ilike('email', auth.user.email || '').maybeSingle();
      const who = author?.name || 'En medlem';
      let sent = 0; const failed = [];
      for (const id of ids) {
        const { data: u } = await supabase.auth.admin.getUserById(id);
        const email = u?.user?.email;
        if (!email) { failed.push(id); continue; }
        const { error } = await resend.emails.send({
          from: FROM, to: email,
          subject: `Nytt svar: ${post.title}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px">
            <p><strong>${esc(who)}</strong> har svarat i diskussionen <strong>${esc(post.title)}</strong> som du följer:</p>
            <div style="border-left:3px solid #3B4760;padding-left:12px;color:#333">${paras(comment.body)}</div>
            <p><a href="${SITE}/forum">Läs diskussionen i forumet</a></p>
            <p style="color:#666;font-size:12px">Du får detta mejl för att du följer diskussionen. Klicka på "Sluta följa" i forumet för att inte få fler mejl.</p>
            <p>Med vänliga hälsningar,<br>LogiKarlskoga</p></div>`,
        });
        if (error) failed.push(id); else sent++;
      }
      return res.json({ sent, failed: failed.length });
    } catch {
      return res.status(500).json({ error: 'Kunde inte skicka aviseringar' });
    }
  };
}
module.exports = { createForumNotifyHandler };
