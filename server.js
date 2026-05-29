const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');

// ============================================
// MAILERLITE HELPER - Add subscriber to group
// ============================================

async function addToMailerLite(email, name, tier) {
      const apiKey = process.env.MAILERLITE_API_KEY;
      const groupId = process.env.MAILERLITE_GROUP_ID;

      if (!apiKey || !groupId) {
              console.log('[MailerLite] Missing MAILERLITE_API_KEY or MAILERLITE_GROUP_ID env vars');
              return false;
      }

      try {
              // Upsert subscriber
              const subRes = await axios.post(
                        'https://connect.mailerlite.com/api/subscribers',
                  {
                              email: email,
                              fields: { name: name || '', tier: tier || '' },
                              groups: [groupId]
                  },
                  {
                              headers: {
                                            Authorization: `Bearer ${apiKey}`,
                                            'Content-Type': 'application/json',
                                            Accept: 'application/json'
                              }
                  }
                      );
              console.log(`[MailerLite] Subscriber ${email} added to group, status: ${subRes.status}`);
              return true;
      } catch (err) {
              const errData = err.response ? JSON.stringify(err.response.data) : err.message;
              console.error(`[MailerLite] Failed to add subscriber: ${errData}`);
              return false;
      }
}

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Store for demo (use database in production)
const members = new Map();

// ============================================
// DISCORD HELPER - Add role after payment
// ============================================

async function addDiscordMemberRole(discordUserId) {
    const token = process.env.DISCORD_BOT_TOKEN;
    const guildId = process.env.DISCORD_SERVER_ID;
    const roleId = process.env.DISCORD_MEMBER_ROLE_ID;

  if (!token || !guildId || !roleId) {
        console.log('[Discord] Missing env vars (BOT_TOKEN, SERVER_ID, MEMBER_ROLE_ID)');
        return false;
  }

  if (!discordUserId) {
        console.log('[Discord] No discordUserId provided, skipping role assignment');
        return false;
  }

  try {
        const response = await axios.put(
                `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
      {},
          {
                    headers: {
                                Authorization: `Bot ${token}`,
                                'Content-Type': 'application/json'
                    }
          }
              );
        console.log(`[Discord] Role assigned to user ${discordUserId}, status: ${response.status}`);
        return true;
  } catch (err) {
        const errData = err.response ? JSON.stringify(err.response.data) : err.message;
        console.error(`[Discord] Failed to assign role: ${errData}`);
        return false;
  }
}

// ============================================
// STRIPE CHECKOUT SESSION
// ============================================

app.post('/create-checkout-session', async (req, res) => {
    const { tier, email, discordUserId } = req.body;

           const priceMap = {
                 fan: process.env.STRIPE_PRICE_FAN,
                 supporter: process.env.STRIPE_PRICE_SUPPORTER,
                 vip: process.env.STRIPE_PRICE_VIP
           };

           const priceId = priceMap[tier];
    if (!priceId) {
          return res.status(400).json({ error: `Invalid tier: ${tier}` });
    }

           try {
                 const session = await stripe.checkout.sessions.create({
                         payment_method_types: ['card'],
                         mode: 'subscription',
                         customer_email: email,
                         line_items: [{ price: priceId, quantity: 1 }],
                         metadata: {
                                   tier: tier,
                                   discordUserId: discordUserId || ''
                         },
                         success_url: `${process.env.DASHBOARD_URL || 'https://earnest-genie-bd83d9.netlify.app'}?session_id={CHECKOUT_SESSION_ID}&tier=${tier}`,
                         cancel_url: `${process.env.LANDING_URL || 'https://iamzynor.com'}`
                 });

      res.json({ sessionId: session.id, url: session.url });
           } catch (err) {
                 console.error('[Stripe] Checkout session error:', err.message);
                 res.status(500).json({ error: err.message });
           }
});

// ============================================
// STRIPE WEBHOOK
// ============================================

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

           try {
                 event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
           } catch (err) {
                 console.error('[Stripe] Webhook verification failed:', err.message);
                 return res.status(400).send(`Webhook Error: ${err.message}`);
           }

           console.log(`[Stripe] Webhook event: ${event.type}`);

           if (event.type === 'checkout.session.completed') {
                 const session = event.data.object;
                 const email = session.customer_email || session.customer_details?.email;
                 const tier = session.metadata?.tier || 'fan';
                 const discordUserId = session.metadata?.discordUserId;
                 const customerId = session.customer;
                 const subscriptionId = session.subscription;

      console.log(`[Stripe] New member: ${email} | tier: ${tier} | discord: ${discordUserId || 'none'}`);

      // Save to members store
      members.set(email, {
              email,
              tier,
              customerId,
              subscriptionId,
              discordUserId: discordUserId || null,
              joinedAt: new Date().toISOString(),
              active: true
      });

      // Add Discord role
      if (discordUserId) {
              const discordOk = await addDiscordMemberRole(discordUserId);
              console.log(`[Discord] Role assignment result: ${discordOk ? 'SUCCESS' : 'FAILED'}`);
      }

                       // Add to MailerLite (triggers Zynor Member Onboarding automation)
                       const memberName = session.metadata?.memberName || session.customer_details?.name || '';
                       const mailerLiteOk = await addToMailerLite(email, memberName, tier);
                       console.log(`[MailerLite] Add subscriber result: ${mailerLiteOk ? 'SUCCESS' : 'FAILED'}`);
               

      // Add to Mailchimp
      try {
              const { MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX, MAILCHIMP_LIST_ID } = process.env;
              if (MAILCHIMP_API_KEY && MAILCHIMP_SERVER_PREFIX && MAILCHIMP_LIST_ID && email) {
                        await axios.post(
                                    `https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members`,
                          {
                                        email_address: email,
                                        status: 'subscribed',
                                        merge_fields: { TIER: tier.charAt(0).toUpperCase() + tier.slice(1) },
                                        tags: [tier, 'zynor-member']
                          },
                          { auth: { username: 'anystring', password: MAILCHIMP_API_KEY } }
                                  );
                        console.log(`[Mailchimp] Added ${email} to list`);
              }
      } catch (mcErr) {
              if (mcErr.response?.status !== 400) {
                        console.error('[Mailchimp] Error:', mcErr.response?.data?.detail || mcErr.message);
              } else {
                        console.log(`[Mailchimp] ${email} already subscribed`);
              }
      }
           }

           if (event.type === 'customer.subscription.deleted') {
                 const sub = event.data.object;
                 for (const [email, member] of members.entries()) {
                         if (member.subscriptionId === sub.id) {
                                   member.active = false;
                                   console.log(`[Stripe] Subscription cancelled for: ${email}`);
                                   break;
                         }
                 }
           }

           res.json({ received: true });
});

// ============================================
// MEMBER API
// ============================================

app.get('/member/:email', (req, res) => {
    const member = members.get(req.params.email);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json({
          email: member.email,
          tier: member.tier,
          active: member.active,
          joinedAt: member.joinedAt
    });
});

app.get('/members/count', (req, res) => {
    const active = [...members.values()].filter(m => m.active).length;
    res.json({ total: members.size, active });
});

// ============================================
// DISCORD INVITE
// ============================================

app.get('/discord-invite', (req, res) => {
    res.json({ invite: process.env.DISCORD_INVITE_LINK || 'https://discord.gg/Ep6Zz5kqd' });
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({
          status: 'ok',
          timestamp: new Date().toISOString(),
          members: members.size,
          discord: {
                  botConfigured: !!process.env.DISCORD_BOT_TOKEN,
                  serverConfigured: !!process.env.DISCORD_SERVER_ID,
                  roleConfigured: !!process.env.DISCORD_MEMBER_ROLE_ID
          }
    });
});

app.get('/', (req, res) => {
    res.json({ message: 'Zynor Backend API', version: '2.1', status: 'running' });
});

// ==========================================
// VERIFY MEMBER ENDPOINT
// ==========================================
app.get('/verify-member', async (req, res) => {
        res.header('Access-Control-Allow-Origin', '*');
        const email = req.query.email;
        if (!email) return res.json({ member: false, reason: 'no_email' });
        const apiKey = process.env.MAILERLITE_API_KEY;
        const groupId = process.env.MAILERLITE_GROUP_ID;
        try {
                  const response = await axios.get(
                              `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`,
                        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' } }
                            );
                  const subscriber = response.data.data;
                  const inGroup = subscriber && subscriber.groups && subscriber.groups.some(g => g.id === groupId);
                  res.json({ member: !!inGroup, email: email, status: subscriber ? subscriber.status : 'not_found' });
        } catch (err) {
                  if (err.response && err.response.status === 404) {
                              res.json({ member: false, reason: 'not_subscribed' });
                  } else {
                              res.json({ member: false, reason: 'error' });
                  }
        }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Zynor backend running on port ${PORT}`);
    console.log(`[Discord] Bot configured: ${!!process.env.DISCORD_BOT_TOKEN}`);
    console.log(`[Discord] Server ID: ${process.env.DISCORD_SERVER_ID}`);
    console.log(`[Discord] Member Role ID: ${process.env.DISCORD_MEMBER_ROLE_ID}`);
});
