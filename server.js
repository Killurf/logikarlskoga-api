const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

const SITE_URL = "logikarl-magic-buddy.lovable.app";

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

// ─── Send meeting invites (email + SMS) ───
app.post("/api/meeting-invites", async (req, res) => {
  const { meeting_id, invitee_ids } = req.body;
  if (!meeting_id || !invitee_ids?.length) {
    return res.status(400).json({ error: "meeting_id and invitee_ids required" });
  }

  try {
    const { data: meeting } = await supabase
      .from("meetings")
      .select("*")
      .eq("id", meeting_id)
      .single();

    if (!meeting) return res.status(404).json({ error: "Meeting not found" });

    const meetingDate = new Date(meeting.date).toLocaleString("sv-SE", {
      timeZone: "Europe/Stockholm",
      dateStyle: "long",
      timeStyle: "short",
    });

    const { data: users } = await supabase
      .from("users")
      .select("id, name, email, phone")
      .in("id", invitee_ids);

    if (!users?.length) return res.status(404).json({ error: "No users found" });

    const results = [];

    for (const user of users) {
      const yesUrl = `${SITE_URL}/mr?m=${meeting_id}&u=${user.id}&a=accept`;
      const noUrl = `${SITE_URL}/mr?m=${meeting_id}&u=${user.id}&a=decline`;

      // Send email
      if (user.email) {
        try {
          await resend.emails.send({
            from: "LogiKarlskoga <noreply@gronfeltsgarden.se>",
            to: user.email,
            subject: `Mötesinbjudan: ${meeting.headline}`,
            html: `
              <h2>${meeting.headline}</h2>
              ${meeting.content ? `<p>${meeting.content}</p>` : ""}
              <p><strong>Datum:</strong> ${meetingDate}</p>
              <p><strong>Plats:</strong> ${meeting.place}</p>
              ${meeting.osa ? `<p><strong>OSA senast:</strong> ${new Date(meeting.osa).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" })}</p>` : ""}
              <p><strong>Skapad av:</strong> ${meeting.created_by_name}${meeting.created_by_company ? ` (${meeting.created_by_company})` : ""}</p>
              <br/>
              <a href="https://${yesUrl}" style="background:#22c55e;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;margin-right:8px;">Ja, jag kommer</a>
              <a href="https://${noUrl}" style="background:#ef4444;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;">Nej, jag kan inte</a>
            `,
          });
          results.push({ user: user.id, email: "sent" });
        } catch (e) {
          console.error("Email error:", e);
          results.push({ user: user.id, email: "failed" });
        }
      }

      // Send SMS
      if (user.phone) {
        try {
          let phone = user.phone.replace(/[\s\-()]/g, "");
          if (phone.startsWith("0")) phone = "46" + phone.slice(1);
          if (!phone.startsWith("46")) phone = "46" + phone;

          const smsText = `Möte: ${meeting.headline}\n${meetingDate}\nPlats: ${meeting.place}\n\nJa:\n${yesUrl}\n\nNej:\n${noUrl}`;

          const smsParams = new URLSearchParams({
            username: process.env.CELLSYNT_USERNAME,
            password: process.env.CELLSYNT_PASSWORD,
            destination: phone,
            originatortype: "alpha",
            originator: "LogiKarlsk",
            type: "text",
            allowconcat: "6",
            charset: "UTF-8",
            text: smsText,
          });

          const smsRes = await fetch(
            "https://se-1.cellsynt.net/sms.php?" + smsParams.toString()
          );
          const smsResult = await smsRes.text();
          console.log("SMS result for", phone, ":", smsResult);
          results.push({ user: user.id, sms: smsResult.startsWith("OK") ? "sent" : "failed" });
        } catch (e) {
          console.error("SMS error:", e);
          results.push({ user: user.id, sms: "failed" });
        }
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error("Meeting invite error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Send manual SMS ───
app.post("/api/send-sms", async (req, res) => {
  const { recipient_user_id, message, sender_name, sender_company } = req.body;
  if (!recipient_user_id || !message) {
    return res.status(400).json({ error: "recipient_user_id and message required" });
  }

  try {
    const { data: user } = await supabase
      .from("users")
      .select("phone")
      .eq("id", recipient_user_id)
      .single();

    if (!user?.phone) return res.status(404).json({ error: "No phone number found" });

    let phone = user.phone.replace(/[\s\-()]/g, "");
    if (phone.startsWith("0")) phone = "46" + phone.slice(1);
    if (!phone.startsWith("46")) phone = "46" + phone;

    const from = sender_company ? `${sender_name} (${sender_company})` : sender_name;
    const smsText = `Från ${from}:\n${message}`;

    const smsParams = new URLSearchParams({
      username: process.env.CELLSYNT_USERNAME,
      password: process.env.CELLSYNT_PASSWORD,
      destination: phone,
      originatortype: "alpha",
      originator: "LogiKarlsk",
      type: "text",
      allowconcat: "6",
      charset: "UTF-8",
      text: smsText,
    });

    const smsRes = await fetch("https://se-1.cellsynt.net/sms.php?" + smsParams.toString());
    const smsResult = await smsRes.text();

    if (smsResult.startsWith("OK")) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: smsResult });
    }
  } catch (err) {
    console.error("Send SMS error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
