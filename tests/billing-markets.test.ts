import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultBillingMarketCatalog,
  getBillingMarket,
  getFlutterwaveFrontendBaseUrl,
  getFlutterwaveWebhookSecret,
  getMarketPricing,
  isFlutterwaveSubscriptionConfigured,
  isValidBillingMarketCatalog,
} from '../src/services/billing-markets.js';

test('billing market lookup normalizes supported country codes and rejects unknown markets', () => {
  assert.equal(getBillingMarket(' ng ')?.countryCode, 'NG');
  assert.equal(getBillingMarket('GH')?.currency, 'GHS');
  assert.equal(getBillingMarket('Ghana')?.countryCode, 'GH');
  assert.equal(getBillingMarket('XX'), null);
  assert.equal(getBillingMarket(undefined), null);
});

test('published Nigerian prices keep the existing Paystack checkout fail-closed on missing credentials', () => {
  const market = getBillingMarket('NG')!;
  const noProvider = getMarketPricing(market, defaultBillingMarketCatalog, false);
  assert.equal(noProvider.checkoutAvailable, false);
  assert.equal(noProvider.provider, null);
  assert.equal(noProvider.plans?.starter.amountMinor, 6000000);

  const available = getMarketPricing(market, defaultBillingMarketCatalog, true);
  assert.equal(available.checkoutAvailable, true);
  assert.equal(available.provider, 'PAYSTACK');
  assert.equal(available.plans?.starter.amountMinor, 6000000);
  assert.match(available.plans?.starter.priceLabel || '', /60,000/);
  assert.match(available.plans?.starter.priceLabel || '', /₦/);
});

test('non-Nigerian legacy amounts remain unpublished drafts and never inherit Nigeria prices', () => {
  const amounts: Record<string, number> = {
    GH: 48000,
    SL: 800000,
    LR: 7500,
    GM: 2500,
  };
  for (const countryCode of Object.keys(amounts)) {
    const market = getBillingMarket(countryCode)!;
    const pricing = getMarketPricing(market, defaultBillingMarketCatalog, true);
    assert.equal(pricing.checkoutAvailable, false, `${countryCode} must remain disabled`);
    assert.equal(pricing.provider, null);
    assert.equal(pricing.plans, null);
    assert.equal(defaultBillingMarketCatalog[market.countryCode].pricingStatus, 'DRAFT');
    assert.equal(defaultBillingMarketCatalog[market.countryCode].checkoutEnabled, false);
    assert.equal(defaultBillingMarketCatalog[market.countryCode].provider, 'FLUTTERWAVE');
    assert.equal(defaultBillingMarketCatalog[market.countryCode].plans.STARTER.amountMinor, amounts[countryCode]);
    assert.notEqual(market.currency, 'NGN');
  }
});

test('published market prices are returned even when checkout is unavailable', () => {
  const catalog = structuredClone(defaultBillingMarketCatalog);
  catalog.GH.pricingStatus = 'PUBLISHED';

  const pricing = getMarketPricing(getBillingMarket('GH')!, catalog, true);
  assert.equal(pricing.checkoutAvailable, false);
  assert.equal(pricing.provider, null);
  assert.equal(pricing.plans?.starter.amountMinor, 48000);
  assert.match(pricing.plans?.starter.priceLabel || '', /480/);
  assert.doesNotMatch(pricing.plans?.starter.priceLabel || '', /₦/);
  assert.doesNotMatch(pricing.plans?.starter.priceLabel || '', /60,000/);
});

test('Flutterwave checkout requires published prices, market review, explicit enablement, and server credentials', () => {
  const catalog = structuredClone(defaultBillingMarketCatalog);
  catalog.GH.pricingStatus = 'PUBLISHED';
  catalog.GH.providerVerified = true;
  catalog.GH.checkoutEnabled = true;

  const pricing = getMarketPricing(getBillingMarket('GH')!, catalog, true);
  assert.equal(pricing.checkoutAvailable, false);
  assert.equal(pricing.plans?.starter.amountMinor, 48000);

  const configured = getMarketPricing(getBillingMarket('GH')!, catalog, true, true);
  assert.equal(configured.checkoutAvailable, true);
  assert.equal(configured.provider, 'FLUTTERWAVE');

  catalog.GH.providerVerified = false;
  assert.equal(getMarketPricing(getBillingMarket('GH')!, catalog, true, true).checkoutAvailable, false);

  catalog.GH.providerVerified = true;
  catalog.GH.checkoutEnabled = false;
  assert.equal(getMarketPricing(getBillingMarket('GH')!, catalog, true, true).checkoutAvailable, false);

  catalog.GH.checkoutEnabled = true;
  catalog.GH.provider = 'PAYSTACK';
  assert.equal(getMarketPricing(getBillingMarket('GH')!, catalog, true, true).checkoutAvailable, false);
});

test('billing catalog validation enforces all markets, supported providers, and safe plan amounts', () => {
  assert.equal(isValidBillingMarketCatalog(defaultBillingMarketCatalog), true);

  const invalidCatalog = structuredClone(defaultBillingMarketCatalog);
  invalidCatalog.SL.plans.STARTER.amountMinor = -1;
  assert.equal(isValidBillingMarketCatalog(invalidCatalog), false);

  const missingMarket = structuredClone(defaultBillingMarketCatalog) as Record<string, unknown>;
  delete missingMarket.GM;
  assert.equal(isValidBillingMarketCatalog(missingMarket), false);
});

test('unsupported countries cannot be resolved to a billing market', () => {
  assert.equal(getBillingMarket('US'), null);
});

test('Flutterwave requires server credentials, webhook signing, and a trusted frontend callback URL', () => {
  assert.equal(isFlutterwaveSubscriptionConfigured({}), false);
  assert.equal(isFlutterwaveSubscriptionConfigured({
    FLUTTERWAVE_SECRET_KEY: 'secret',
    FLUTTERWAVE_WEBHOOK_SECRET_HASH: 'hash',
  }), false);
  assert.equal(isFlutterwaveSubscriptionConfigured({
    FLUTTERWAVE_SECRET_KEY: 'secret',
    FLUTTERWAVE_WEBHOOK_SECRET_HASH: 'hash',
    FRONTEND_URL: 'http://example.com',
  }), false);
  assert.equal(isFlutterwaveSubscriptionConfigured({
    FLUTTERWAVE_SECRET_KEY: 'secret',
    FLUTTERWAVE_WEBHOOK_SECRET_HASH: 'hash',
    FRONTEND_URL: 'https://schoolbase.live',
  }), true);
  assert.equal(isFlutterwaveSubscriptionConfigured({
    FLUTTERWAVE_SECRET_KEY: 'secret',
    FLUTTERWAVE_WEBHOOK_SECRET: 'hash',
    FRONTEND_URL: 'https://schoolbase.live',
  }), true);
  assert.equal(getFlutterwaveWebhookSecret({ FLUTTERWAVE_WEBHOOK_SECRET: ' legacy-hash ' }), 'legacy-hash');
  assert.equal(getFlutterwaveWebhookSecret({
    FLUTTERWAVE_WEBHOOK_SECRET_HASH: 'canonical-hash',
    FLUTTERWAVE_WEBHOOK_SECRET: 'legacy-hash',
  }), 'canonical-hash');
  assert.equal(
    getFlutterwaveFrontendBaseUrl('https://schoolbase.live/path,https://admin.schoolbase.live'),
    'https://schoolbase.live',
  );
  assert.equal(getFlutterwaveFrontendBaseUrl('https://user:pass@schoolbase.live'), null);
  assert.equal(getFlutterwaveFrontendBaseUrl('ftp://localhost'), null);
});
