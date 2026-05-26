const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Store for demo (use database in production)
const subscriptions = new Map();

// ============================================
// STRIPE WEBHOOK ENDPOINT
// ============================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.sendStatus(400);
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        const subscription = event.data.object;
        subscriptions.set(subscription.customer, {
          subscriptionId: subscription.id,
          customerId: subscription.customer,
          status: subscription.status,
          priceId: subscription.items.data[0].price.id,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
          email: subscription.description
        });
        console.log('Subscription created/updated:', subscription.id);
        break;

      case 'customer.subscription.deleted':
        const deletedSub = event.data.object;
        subscriptions.delete(deletedSub.customer);
        console.log('Subscription cancelled:', deletedSub.id);
        break;

      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log('Payment succeeded:', paymentIntent.id);
        break;

      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        console.log('Payment failed:', failedPayment.id);
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  } catch (err) {
    console.error('Error handling webhook:', err);
  }

  res.json({ received: true });
});

// ============================================
// CREATE PAYMENT INTENT (One-time payment)
// ============================================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, email, planName } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: {
        email,
        planName,
        type: 'zynor_membership'
      },
      description: `Zynor ${planName} subscription`
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// CREATE SUBSCRIPTION (Recurring billing)
// ============================================
app.post('/create-subscription', async (req, res) => {
  try {
    const { email, paymentMethodId, priceId, planName, username, fullname } = req.body;

    // Create or get customer
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: {
          username,
          fullname,
          joinDate: new Date().toISOString()
        }
      });
    }

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customer.id
    });

    // Set as default
    await stripe.customers.update(customer.id, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      metadata: {
        planName,
        username
      },
      description: `${username} - ${planName}`,
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on'
      }
    });

    // Store subscription locally
    subscriptions.set(customer.id, {
      subscriptionId: subscription.id,
      customerId: customer.id,
      email,
      username,
      planName,
      status: subscription.status,
      priceId,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000)
    });

    res.json({
      subscriptionId: subscription.id,
      customerId: customer.id,
      status: subscription.status,
      message: `Welcome ${username}! Your subscription is active.`
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// GET SUBSCRIPTION STATUS
// ============================================
app.post('/get-subscription', async (req, res) => {
  try {
    const { customerId } = req.body;

    const subs = await stripe.subscriptions.list({
      customer: customerId,
      limit: 1
    });

    if (subs.data.length === 0) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    const sub = subs.data[0];
    res.json({
      subscriptionId: sub.id,
      status: sub.status,
      priceId: sub.items.data[0].price.id,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end
    });
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// CANCEL SUBSCRIPTION
// ============================================
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { subscriptionId } = req.body;

    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });

    res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAt: new Date(subscription.cancel_at * 1000),
      message: 'Your subscription will be cancelled at the end of your billing period.'
    });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// UPDATE PAYMENT METHOD
// ============================================
app.post('/update-payment-method', async (req, res) => {
  try {
    const { customerId, paymentMethodId } = req.body;

    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId
    });

    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });

    res.json({
      message: 'Payment method updated successfully'
    });
  } catch (error) {
    console.error('Error updating payment method:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// GET INVOICES (Member billing history)
// ============================================
app.post('/get-invoices', async (req, res) => {
  try {
    const { customerId } = req.body;

    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 12
    });

    const formattedInvoices = invoices.data.map(inv => ({
      id: inv.id,
      amount: inv.amount_paid / 100,
      date: new Date(inv.created * 1000),
      status: inv.status,
      pdfUrl: inv.invoice_pdf
    }));

    res.json({
      invoices: formattedInvoices
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'Zynor backend is running!' });
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Zynor Backend Server Running on Port ${PORT}`);
  console.log('Webhook: POST /webhook');
  console.log('Create Subscription: POST /create-subscription');
  console.log('Get Subscription: POST /get-subscription');
  console.log('Cancel Subscription: POST /cancel-subscription');
  console.log('Update Payment: POST /update-payment-method');
  console.log('Get Invoices: POST /get-invoices');
  console.log('Health Check: GET /health');
});

module.exports = app;
