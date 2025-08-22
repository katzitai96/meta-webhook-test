// api/index.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const isLocal = process.env.VERCEL !== "1"; // Vercel injects VERCEL=1

if (isLocal) {
  // allow local .env for dev only
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
}

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());

// WhatsApp Cloud API config
const WHATSAPP_API_URL = "https://graph.facebook.com/v18.0";
const getWhatsAppConfig = () => ({
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
});

// Helper
const sendTextMessage = async (to, message) => {
  const config = getWhatsAppConfig();
  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error(
      "WhatsApp configuration missing: phoneNumberId or accessToken"
    );
  }
  const cleanPhoneNumber = to.replace("whatsapp:", "").replace("+", "");
  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhoneNumber,
    text: { body: message },
  };
  const response = await axios.post(
    `${WHATSAPP_API_URL}/${config.phoneNumberId}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
};

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ===== API ROUTES (unchanged) =====

// Send single
app.post("/api/send-message", async (req, res) => {
  try {
    const { to, body } = req.body;
    const whatsappResponse = await sendTextMessage(to, body);

    const { data: messageRecord, error: dbError } = await supabase
      .from("message_history")
      .insert([
        {
          invitee_id: req.body.inviteeId || null,
          template_id: req.body.templateId || null,
          message_body: body,
          sent_at: new Date(),
          status: "delivered",
          whatsapp_message_id: whatsappResponse.messages?.[0]?.id || null,
        },
      ])
      .select();

    if (dbError) console.error("DB insert error:", dbError);

    res.json({
      success: true,
      whatsappMessageId: whatsappResponse.messages?.[0]?.id,
      messageHistoryId: messageRecord?.[0]?.id,
      whatsappResponse,
    });
  } catch (error) {
    const errorMessage = error.response?.data?.error?.message || error.message;
    const errorCode = error.response?.data?.error?.code || "UNKNOWN_ERROR";
    res.status(500).json({
      success: false,
      error: errorMessage,
      errorCode,
      details: error.response?.data || null,
    });
  }
});

// Send bulk
app.post("/api/send-bulk-messages", async (req, res) => {
  try {
    const { messages } = req.body;
    const results = [];
    const errors = [];
    for (const msgData of messages) {
      try {
        const whatsappResponse = await sendTextMessage(
          msgData.to,
          msgData.body
        );
        const { data: messageRecord, error: dbError } = await supabase
          .from("message_history")
          .insert([
            {
              invitee_id: msgData.inviteeId || null,
              template_id: msgData.templateId || null,
              message_body: msgData.body,
              sent_at: new Date(),
              status: "sent",
              whatsapp_message_id: whatsappResponse.messages?.[0]?.id || null,
            },
          ])
          .select();
        if (dbError) console.error("DB insert error:", dbError);
        results.push({
          to: msgData.to,
          whatsappMessageId: whatsappResponse.messages?.[0]?.id,
          messageHistoryId: messageRecord?.[0]?.id,
        });
      } catch (e) {
        errors.push({ to: msgData.to, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    res.json({ success: true, results, errors });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Schedule (fixed a variable name bug: scheduled_date -> scheduledDate)
app.post("/api/schedule-message", async (req, res) => {
  try {
    const { to, body, scheduledDate, inviteeId, templateId } = req.body;
    const { data, error } = await supabase
      .from("scheduled_messages")
      .insert([
        {
          to,
          body,
          invitee_id: inviteeId || null,
          template_id: templateId || null,
          scheduled_date: scheduledDate, // <-- match your DB column
          created_at: new Date(),
        },
      ])
      .select();
    if (error) throw error;
    res.json({ success: true, scheduledMessageId: data[0].id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// WhatsApp webhook verify + receive
app.get("/api/webhook-response", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const config = getWhatsAppConfig();
  if (mode === "subscribe" && token === config.webhookVerifyToken) {
    console.log("Webhook verified successfully");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Forbidden");
});

app.post("/api/webhook-response", async (req, res) => {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    if (!req.body) return res.status(400).send("Bad Request: Empty body");
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value || !value.messages) {
      if (value?.statuses?.length) {
        for (const s of value.statuses) {
          console.log("WA status:", {
            id: s.id,
            status: s.status, // sent, delivered, read, failed
            timestamp: s.timestamp,
            conversation: s.conversation, // type, id, origin
            pricing: s.pricing, // category, billable
            errors: s.errors, // <-- reason codes live here
          });

          // optional: persist to DB
          // await supabase.from("wa_status").insert([{ ... }]);
        }
        return res.status(200).send("OK");
      }
    }
    const message = value.messages[0];
    const contact = value.contacts?.[0];
    const messageText = message.text?.body || "";
    const from = message.from;
    const messageId = message.id;

    const { data: invitees, error: lookupError } = await supabase
      .from("invitees")
      .select("*")
      .eq("phone_number", from)
      .limit(1);

    if (!lookupError && invitees?.[0]) {
      const invitee = invitees[0];
      let rsvpStatus = "pending";
      const t = messageText.toLowerCase();
      if (/(^|\b)(yes|attending|will attend)(\b|$)/.test(t))
        rsvpStatus = "confirmed";
      else if (/(^|\b)(no|not attending|cannot attend)(\b|$)/.test(t))
        rsvpStatus = "declined";
      else if (/(^|\b)(maybe|possibly)(\b|$)/.test(t)) rsvpStatus = "maybe";

      if (rsvpStatus !== "pending") {
        await supabase
          .from("invitees")
          .update({
            rsvp_status: rsvpStatus,
            additional_info: invitee.additional_info
              ? `${
                  invitee.additional_info
                }\n${new Date().toISOString()}: ${messageText}`
              : `${new Date().toISOString()}: ${messageText}`,
            updated_at: new Date(),
          })
          .eq("id", invitee.id);
      }

      await supabase.from("message_history").insert([
        {
          invitee_id: invitee.id,
          message_body: messageText,
          sent_at: new Date(),
          status: "delivered",
          response_received: true,
          response_text: messageText,
          response_received_at: new Date(),
          whatsapp_message_id: messageId,
        },
      ]);
    }

    res.status(200).send("OK");
  } catch (e) {
    if (!res.headersSent) res.status(500).send("Error processing webhook");
  }
});

// Export as a Vercel function handler
module.exports = (req, res) => app(req, res);

// (NO app.listen here)
