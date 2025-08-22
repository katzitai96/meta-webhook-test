const axios = require("axios");
const { getSupabaseClient } = require("./_utils");

// WhatsApp Cloud API configuration
const WHATSAPP_API_URL = "https://graph.facebook.com/v22.0";

/**
 * Get WhatsApp Cloud API client configuration
 */
const getWhatsAppConfig = () => {
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  };
};

/**
 * Send a text message via WhatsApp Cloud API
 */
const sendTextMessage = async (to, message) => {
  const config = getWhatsAppConfig();

  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error(
      "WhatsApp configuration missing: phoneNumberId or accessToken"
    );
  }

  // Remove any 'whatsapp:' prefix and ensure correct format
  const cleanPhoneNumber = to.replace("whatsapp:", "");

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhoneNumber,
    type: "text",
    text: {
      body: message,
    },
  };
  console.log("Sending WhatsApp message:", JSON.stringify(payload, null, 2));
  try {
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
  } catch (error) {
    console.error("WhatsApp API Error:", error.response?.data || error.message);
    throw error;
  }
};

/**
 * Send a template message via WhatsApp Cloud API
 */
const sendTemplateMessage = async (to, templateName, templateParams = []) => {
  const config = getWhatsAppConfig();

  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error(
      "WhatsApp configuration missing: phoneNumberId or accessToken"
    );
  }

  const cleanPhoneNumber = to.replace("whatsapp:", "");

  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhoneNumber,
    type: "template",
    template: {
      name: templateName,
      language: {
        code: "en_US", // Adjust based on your template language
      },
      components:
        templateParams.length > 0
          ? [
              {
                type: "body",
                parameters: templateParams.map((param) => ({
                  type: "text",
                  text: param,
                })),
              },
            ]
          : [],
    },
  };

  try {
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
  } catch (error) {
    console.error(
      "WhatsApp Template API Error:",
      error.response?.data || error.message
    );
    throw error;
  }
};

/**
 * Verify webhook signature (for production)
 */
const verifyWebhookSignature = (payload, signature, appSecret) => {
  const crypto = require("crypto");
  const expectedSignature = crypto
    .createHmac("sha256", appSecret)
    .update(payload)
    .digest("hex");

  return `sha256=${expectedSignature}` === signature;
};

/**
 * Parse WhatsApp webhook payload
 */
const parseWebhookPayload = (body) => {
  try {
    // WhatsApp Cloud API webhook structure
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value || !value.messages) {
      return null;
    }

    const message = value.messages[0];
    const contact = value.contacts?.[0];

    return {
      messageId: message.id,
      from: message.from,
      timestamp: message.timestamp,
      type: message.type,
      text: message.text?.body || "",
      contactName: contact?.profile?.name || "",
      waId: contact?.wa_id || message.from,
    };
  } catch (error) {
    console.error("Error parsing webhook payload:", error);
    return null;
  }
};

module.exports = {
  getWhatsAppConfig,
  sendTextMessage,
  sendTemplateMessage,
  verifyWebhookSignature,
  parseWebhookPayload,
  WHATSAPP_API_URL,
};
