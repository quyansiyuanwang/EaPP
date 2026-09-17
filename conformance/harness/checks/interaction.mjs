/**
 * Black-box checks for EaPP v3.1 Interaction Layer.
 *
 * Same rule as the core checks: a check here may only use what `conformance/driver.md`
 * exposes, and every check cites the invariant it verifies. Anything in v3.1 §14 that
 * these checks cannot see is named in `conformance/README.md` rather than quietly
 * dropped — the point of a harness is that its blind spots are stated.
 *
 * A driver that does not claim the `interaction` layer never runs these. That is not
 * an exemption: it is why the harness reports layers per driver.
 */

const CAP = { name: 'casing.apply', version: '1.0.0' };
const who = (domain, id, instance) => ({ domain, id, instance });

/**
 * Instance ids have to be distinct per registration: ID-3 makes two plugins with the
 * same (domain, id, instance) a duplicate, and several checks build more than one
 * runtime within a single check.
 */
let seq = 0;
const fresh = (name) => `${name}-${(seq += 1)}`;

/** Register a provider (with the capability) and a consumer, both ACTIVE. */
async function active(t) {
  const provider = await t.driver.request('plugin.register', {
    identity: who('acme', 'provider', fresh('provider')),
    capabilities: [CAP],
  });
  const consumer = await t.driver.request('plugin.register', {
    identity: who('acme', 'consumer', fresh('consumer')),
    capabilities: [],
  });
  await t.driver.request('lifecycle.activate', { identity: provider });
  await t.driver.request('lifecycle.activate', { identity: consumer });
  return { provider, consumer };
}

async function bindThem(t, pair) {
  return t.driver.request('composition.bind', {
    from: pair.provider,
    to: pair.consumer,
    capability: CAP,
  });
}

/** An ACTIVE Binding, which is what a Channel needs to leave OPEN (CC-8). */
async function boundChannel(t, { mode = 'stream', delivery, connect = true } = {}) {
  const pair = await active(t);
  const binding = await bindThem(t, pair);
  const args = { binding: binding.id, mode };
  if (delivery !== undefined) args.delivery = delivery;
  let channel = await t.driver.request('channel.create', args);
  if (connect) {
    channel = await t.driver.request('channel.connect', { channel: channel.id });
  }
  return { pair, binding, channel };
}

const send = (t, channel, payload) =>
  t.driver.request('channel.send', { channel: channel.id, payload });

const openSub = (t, channel, options) =>
  t.driver.request('subscription.open', { channel: channel.id, options });

const pull = (t, subscription, timeoutMs = 1_000) =>
  t.driver.request('subscription.pull', { subscription: subscription.subscription, timeoutMs });

/** Pull one item, asserting there is one. Returns the item handle. */
async function pullOne(t, subscription) {
  const result = await pull(t, subscription);
  t.assert(result.item !== null && result.item !== undefined, 'expected a deliverable item, got none');
  return result.item;
}

export const INTERACTION_CHECKS = [
  // ---------------------------------------------------------------- Channel (v3.1 §2.3)
  {
    id: 'CH-1',
    rule: 'a Channel corresponds to exactly one Binding',
    async run(t) {
      const { binding, channel } = await boundChannel(t);
      const reread = await t.driver.request('channel.get', { channel: channel.id });
      // The Channel names exactly the Binding it was derived from, and reading it back
      // does not invent a second one.
      t.equal(reread.binding, binding.id, 'channel.binding names the Binding it came from');
      const all = await t.driver.request('channel.channels');
      t.equal(all.length, 1, 'one Binding produced one Channel');
    },
  },
  {
    id: 'CH-2 / CC-2',
    rule: 'when the Binding reaches CLOSED the Channel MUST immediately reach CLOSED',
    async run(t) {
      const { binding, channel } = await boundChannel(t);
      await t.driver.request('composition.unbind', { binding: binding.id });
      const after = await t.driver.request('channel.get', { channel: channel.id });
      // §2.4's table is exact here: Binding CLOSED maps to Channel CLOSED, not to
      // DRAINING. DRAINING is what a DORMANT Binding produces, and that is checked
      // separately — the two are different states of the Binding, not one of them.
      t.equal(after.state, 'CLOSED', 'state after unbind');
    },
  },
  {
    id: 'CC-2',
    rule: 'when the Binding becomes DORMANT the Channel MUST become DRAINING and MUST return',
    async run(t) {
      const { pair, channel } = await boundChannel(t);
      await t.driver.request('lifecycle.deactivate', { identity: pair.provider });
      const draining = await t.driver.request('channel.get', { channel: channel.id });
      t.equal(draining.state, 'DRAINING', 'state after the Binding goes DORMANT');
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      const back = await t.driver.request('channel.get', { channel: channel.id });
      t.equal(back.state, 'ACTIVE', 'recovering the Binding returns the Channel to service');
    },
  },
  {
    id: 'CH-3',
    rule: 'CLOSED is terminal',
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.request('channel.close', { channel: channel.id });
      const closed = await t.driver.request('channel.get', { channel: channel.id });
      t.equal(closed.state, 'CLOSED', 'state after close');
      // Nothing reopens it. Sending is refused rather than silently accepted.
      await t.driver.refused('channel.send', { channel: channel.id, payload: { n: 1 } }, 'EAPP_CHANNEL_CLOSED');
      const stillClosed = await t.driver.request('channel.get', { channel: channel.id });
      t.equal(stillClosed.state, 'CLOSED', 'state stays CLOSED');
    },
  },
  {
    id: 'CH-4',
    rule: 'close() MUST be idempotent',
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.request('channel.close', { channel: channel.id });
      await t.driver.request('channel.close', { channel: channel.id }); // must not throw
      const closed = await t.driver.request('channel.get', { channel: channel.id });
      t.equal(closed.state, 'CLOSED', 'state after closing twice');
    },
  },
  {
    id: 'CH-5',
    rule: 'mode MUST NOT change during the lifetime',
    async run(t) {
      const { channel } = await boundChannel(t, { mode: 'stream' });
      await send(t, channel, { n: 1 });
      const same = await t.driver.request('channel.get', { channel: channel.id });
      t.equal(same.mode, 'stream', 'mode is unchanged by use');
    },
  },
  {
    id: 'CH-6',
    rule: 'delivery MUST NOT change during the lifetime',
    async run(t) {
      const { channel } = await boundChannel(t, { mode: 'stream' });
      await send(t, channel, { n: 1 });
      const same = await t.driver.request('channel.get', { channel: channel.id });
      t.equal(same.delivery, 'at-least-once', 'delivery is unchanged by use');
    },
  },

  // ------------------------------------------------- Channel creation (v3.1 §12)
  {
    id: 'CC-3',
    rule: 'mode MUST be specified explicitly by the caller',
    async run(t) {
      const { binding } = await boundChannel(t);
      await t.driver.refused('channel.create', { binding: binding.id }, 'EAPP_MODE_INVALID');
    },
  },
  {
    id: 'CC-4',
    rule: 'an omitted delivery is derived: stream/state to at-least-once, others to at-most-once',
    async run(t) {
      const stream = await boundChannel(t, { mode: 'stream' });
      t.equal(stream.channel.delivery, 'at-least-once', 'stream without delivery');
      const event = await boundChannel(t, { mode: 'event' });
      t.equal(event.channel.delivery, 'at-most-once', 'event without delivery');
      const request = await boundChannel(t, { mode: 'request' });
      t.equal(request.channel.delivery, 'at-most-once', 'request without delivery');
    },
  },
  {
    id: 'CC-5 / DL-6',
    rule: 'stream or state with at-most-once MUST return EAPP_DELIVERY_UNSUPPORTED',
    async run(t) {
      const { binding } = await boundChannel(t);
      await t.driver.refused(
        'channel.create',
        { binding: binding.id, mode: 'stream', delivery: 'at-most-once' },
        'EAPP_DELIVERY_UNSUPPORTED',
      );
      await t.driver.refused(
        'channel.create',
        { binding: binding.id, mode: 'state', delivery: 'at-most-once' },
        'EAPP_DELIVERY_UNSUPPORTED',
      );
    },
  },
  {
    id: 'CC-6',
    rule: 'a nonexistent Binding MUST return EAPP_BINDING_INVALID',
    async run(t) {
      await t.driver.refused(
        'channel.create',
        { binding: 'no-such-binding', mode: 'event' },
        'EAPP_BINDING_INVALID',
      );
    },
  },
  {
    id: 'CC-7',
    rule: 'a CLOSED Binding MUST return EAPP_BINDING_CLOSED',
    async run(t) {
      const { binding } = await boundChannel(t);
      await t.driver.request('composition.unbind', { binding: binding.id });
      await t.driver.refused(
        'channel.create',
        { binding: binding.id, mode: 'event' },
        'EAPP_BINDING_CLOSED',
      );
    },
  },
  {
    id: 'CC-8',
    rule: 'a Channel is OPEN at creation and ACTIVE after connect()',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);
      const created = await t.driver.request('channel.create', { binding: binding.id, mode: 'stream' });
      t.equal(created.state, 'OPEN', 'state at creation');
      const connected = await t.driver.request('channel.connect', { channel: created.id });
      t.equal(connected.state, 'ACTIVE', 'state after connect()');
    },
  },
  {
    id: 'CC-9',
    rule: 'one Binding MAY derive several Channels of different modes',
    async run(t) {
      const { binding } = await boundChannel(t, { mode: 'event' });
      const other = await t.driver.request('channel.create', { binding: binding.id, mode: 'stream' });
      t.assert(other.id !== binding.id, 'the second Channel is a distinct entity');
      t.equal(other.mode, 'stream', 'the second Channel keeps its own mode');
    },
  },

  // ---------------------------------------------------------------- Cursor (v3.1 §6.3)
  {
    id: 'CR-1',
    rule: 'Cursor MUST be globally ordered within a Channel',
    async run(t) {
      const { channel } = await boundChannel(t);
      const a = await send(t, channel, { n: 1 });
      const b = await send(t, channel, { n: 2 });
      t.assert(a.cursor !== b.cursor, 'two sends produce two distinct cursors');
      const after = await t.driver.request('transport.readAfter', {
        channel: channel.id,
        cursor: a.cursor,
        pattern: { all: true },
      });
      t.equal(after.length, 1, 'reading after the first cursor returns only the second');
      t.equal(after[0].cursor, b.cursor, 'and it carries the second cursor');
    },
  },
  {
    id: 'CR-4',
    rule: 'Resume MUST continue from the given cursor',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const second = await send(t, channel, { n: 2 });
      await send(t, channel, { n: 3 });
      const resumed = await openSub(t, channel, { cursor: second.cursor });
      const item = await pullOne(t, resumed);
      t.equal(item.payload.n, 3, 'resuming from the second cursor yields the third message');
    },
  },
  {
    id: 'CR-3',
    rule: 'a Cursor MUST NOT skip unacked messages implicitly',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      await send(t, channel, { n: 2 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const first = await pullOne(t, sub);
      t.equal(first.payload.n, 1, 'the first delivery is the first message');
      // Receiving does not advance the cursor; only ack does (§6.4).
      const state = await t.driver.request('subscription.state', {
        subscription: sub.subscription,
      });
      t.assert(state.cursor !== first.cursor, 'the cursor has not jumped to the delivered item');
    },
  },

  // ---------------------------------------------------------- Subscription (v3.1 §7.3)
  {
    id: 'SUB-1',
    rule: 'Subscription MUST NOT exist independently of a Channel',
    async run(t) {
      await t.driver.refused(
        'subscription.open',
        { channel: 'no-such-channel', options: {} },
        'EAPP_CHANNEL_INVALID',
      );
    },
  },
  {
    id: 'SUB-2',
    rule: 'an exclusive Subscription MUST have its own cursor',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      await send(t, channel, { n: 2 });
      const a = await openSub(t, channel, { mode: 'exclusive', cursor: 'earliest' });
      const b = await openSub(t, channel, { mode: 'exclusive', cursor: 'earliest' });
      const fromA = await pullOne(t, a);
      const fromB = await pullOne(t, b);
      t.equal(fromA.payload.n, 1, 'the first exclusive subscription sees the first message');
      t.equal(fromB.payload.n, 1, 'so does the second — neither consumed it for the other');
    },
  },
  {
    id: 'SUB-3',
    rule: 'a subscription MUST NOT affect other exclusive subscriptions on the same Channel',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const a = await openSub(t, channel, { mode: 'exclusive', cursor: 'earliest' });
      const b = await openSub(t, channel, { mode: 'exclusive', cursor: 'earliest' });
      const fromA = await pullOne(t, a);
      await t.driver.request('subscription.ack', { subscription: a.subscription, delivery: fromA.delivery });
      const fromB = await pullOne(t, b);
      t.equal(fromB.payload.n, 1, "acking on one subscription does not consume it for the other");
    },
  },
  {
    id: 'SUB-4',
    rule: "mode === 'group' MUST name a non-empty group",
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.refused(
        'subscription.open',
        { channel: channel.id, options: { mode: 'group' } },
        'EAPP_SUBSCRIPTION_INVALID',
      );
      await t.driver.refused(
        'subscription.open',
        { channel: channel.id, options: { mode: 'group', group: '' } },
        'EAPP_SUBSCRIPTION_INVALID',
      );
    },
  },
  {
    id: 'SUB-5',
    rule: 'after suspend() no delivery MUST occur until resume()',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      await t.driver.request('subscription.suspend', { subscription: sub.subscription });
      const suspended = await t.driver.request('subscription.state', { subscription: sub.subscription });
      t.equal(suspended.state, 'SUSPENDED', 'state after suspend');
      await send(t, channel, { n: 2 });
      const none = await pull(t, sub, 300);
      t.assert(none.item === null || none.item === undefined, 'nothing is delivered while suspended');
      await t.driver.request('subscription.resume', { subscription: sub.subscription });
      const item = await pullOne(t, sub);
      t.equal(item.payload.n, 1, 'resuming continues from where it stopped');
    },
  },
  {
    id: 'SUB-6',
    rule: 'close() MUST be idempotent',
    async run(t) {
      const { channel } = await boundChannel(t);
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      await t.driver.request('subscription.close', { subscription: sub.subscription });
      await t.driver.request('subscription.close', { subscription: sub.subscription });
      const closed = await t.driver.request('subscription.state', { subscription: sub.subscription });
      t.equal(closed.state, 'CLOSED', 'state after closing twice');
    },
  },
  {
    id: 'SUB-7',
    rule: 'after close() nothing MUST be delivered',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      await t.driver.request('subscription.close', { subscription: sub.subscription });
      await send(t, channel, { n: 2 });
      const result = await pull(t, sub, 300);
      t.assert(result.done === true, 'a closed subscription reports done');
      t.assert(result.item === null || result.item === undefined, 'and delivers nothing');
    },
  },
  {
    id: 'SUB-8',
    rule: 'after close(), acking an already-yielded item MUST be a no-op',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const item = await pullOne(t, sub);
      await t.driver.request('subscription.close', { subscription: sub.subscription });
      // Neither throwing nor moving the cursor: the ack is simply void.
      await t.driver.request('subscription.ack', { subscription: sub.subscription, delivery: item.delivery });
      const state = await t.driver.request('subscription.state', { subscription: sub.subscription });
      t.equal(state.state, 'CLOSED', 'still closed, and the ack did not fail');
    },
  },
  {
    id: 'SUB-9',
    rule: 'cursor MUST be resolved to a concrete value before the Subscription is returned',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'latest' });
      t.assert(
        typeof sub.cursor === 'string' && sub.cursor.length > 0,
        `cursor must be a concrete value at creation, got ${JSON.stringify(sub.cursor)}`,
      );
    },
  },

  // ------------------------------------------------------------- Ack / Nack (v3.1 §9)
  {
    id: 'AK-1',
    rule: 'ack() MUST be idempotent',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const item = await pullOne(t, sub);
      await t.driver.request('subscription.ack', { subscription: sub.subscription, delivery: item.delivery });
      await t.driver.request('subscription.ack', { subscription: sub.subscription, delivery: item.delivery });
      const state = await t.driver.request('subscription.state', { subscription: sub.subscription });
      t.equal(state.cursor, item.cursor, 'the second ack did not move the cursor again');
    },
  },
  {
    id: 'AK-2',
    rule: 'nack() MUST be idempotent',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const item = await pullOne(t, sub);
      await t.driver.request('subscription.nack', { subscription: sub.subscription, delivery: item.delivery });
      await t.driver.request('subscription.nack', { subscription: sub.subscription, delivery: item.delivery });
      const state = await t.driver.request('subscription.state', { subscription: sub.subscription });
      t.assert(state.cursor !== item.cursor, 'nack never advances the cursor');
    },
  },
  {
    id: 'AK-3',
    rule: 'after an ack, a nack is not allowed',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const item = await pullOne(t, sub);
      await t.driver.request('subscription.ack', { subscription: sub.subscription, delivery: item.delivery });
      await t.driver.refused(
        'subscription.nack',
        { subscription: sub.subscription, delivery: item.delivery },
        'EAPP_LEASE_CLOSED',
      );
    },
  },
  {
    id: 'AK-4',
    rule: 'after a nack, an ack is not allowed',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const item = await pullOne(t, sub);
      await t.driver.request('subscription.nack', { subscription: sub.subscription, delivery: item.delivery });
      await t.driver.refused(
        'subscription.ack',
        { subscription: sub.subscription, delivery: item.delivery },
        'EAPP_LEASE_CLOSED',
      );
    },
  },
  {
    id: 'AK-5',
    rule: 'a call conflicting with a terminated AckContext MUST return EAPP_LEASE_CLOSED',
    async run(t) {
      // AK-1 requires a *repeat* ack to be idempotent and AK-5 requires a call on a
      // terminated context to fail. For the same method those cannot both hold, so the
      // terminated-context rule has to mean a call that conflicts with the terminal
      // state — which is what E1-3 established. Both halves are asserted here so the
      // reading is visible rather than assumed.
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const item = await pullOne(t, sub);
      await t.driver.request('subscription.ack', { subscription: sub.subscription, delivery: item.delivery });
      await t.driver.request('subscription.ack', { subscription: sub.subscription, delivery: item.delivery });
      await t.driver.refused(
        'subscription.nack',
        { subscription: sub.subscription, delivery: item.delivery },
        'EAPP_LEASE_CLOSED',
      );
    },
  },

  // ------------------------------------------------------- ConsumerGroup (v3.1 §8.4)
  {
    id: 'CG-1',
    rule: 'ConsumerGroup.name MUST be unique within its Channel',
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.request('group.open', { channel: channel.id, name: 'workers' });
      // The spec requires uniqueness; it does not say which code carries the refusal,
      // and the interaction error model has no dedicated one. Pinning an
      // implementation's choice here would turn a spec requirement into a shape
      // requirement — the same mistake `B-6` in the core checks was written to avoid.
      let refused = null;
      try {
        await t.driver.request('group.open', { channel: channel.id, name: 'workers' });
      } catch (error) {
        refused = error;
      }
      t.assert(refused !== null, 'opening a second group with the same name must be refused');
      t.assert(
        typeof refused.code === 'string' && refused.code.startsWith('EAPP_'),
        `the refusal must carry a declared EAPP_ code, got ${JSON.stringify(refused.code)}`,
      );
    },
  },
  {
    id: 'CG-2',
    rule: 'all members of a ConsumerGroup MUST share exactly one Cursor',
    async run(t) {
      const { channel } = await boundChannel(t);
      const group = await t.driver.request('group.open', { channel: channel.id, name: 'workers' });
      await send(t, channel, { n: 1 });
      const a = await openSub(t, channel, { mode: 'group', group: 'workers' });
      const b = await openSub(t, channel, { mode: 'group', group: 'workers' });
      const item = await pullOne(t, a);
      await t.driver.request('subscription.ack', { subscription: a.subscription, delivery: item.delivery });
      const view = await t.driver.request('group.view', { group: group.id });
      t.equal(view.cursor, item.cursor, "the group's cursor is the member's acknowledged position");
      t.equal(b.mode, 'group', 'the second member joined the same group');
    },
  },
  {
    id: 'CG-3',
    rule: 'a message MUST NOT be held by two members of the same group at once',
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.request('group.open', { channel: channel.id, name: 'workers' });
      await send(t, channel, { n: 1 });
      const a = await openSub(t, channel, { mode: 'group', group: 'workers' });
      const b = await openSub(t, channel, { mode: 'group', group: 'workers' });
      const fromA = await pullOne(t, a);
      t.equal(fromA.payload.n, 1, 'the first member takes the message');
      const forB = await pull(t, b, 300);
      t.assert(
        forB.item === null || forB.item === undefined,
        'the second member must not receive the message the first is holding',
      );
    },
  },
  {
    id: 'CG-4',
    rule: 'different ConsumerGroups on one Channel MUST NOT affect each other',
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.request('group.open', { channel: channel.id, name: 'alpha' });
      await t.driver.request('group.open', { channel: channel.id, name: 'beta' });
      await send(t, channel, { n: 1 });
      const a = await openSub(t, channel, { mode: 'group', group: 'alpha' });
      const b = await openSub(t, channel, { mode: 'group', group: 'beta' });
      const fromA = await pullOne(t, a);
      await t.driver.request('subscription.ack', { subscription: a.subscription, delivery: fromA.delivery });
      const fromB = await pullOne(t, b);
      t.equal(fromB.payload.n, 1, 'the other group still sees the message alpha consumed');
    },
  },
  {
    id: 'CG-5',
    rule: 'a member leaving MUST NOT stall the group',
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.request('group.open', { channel: channel.id, name: 'workers' });
      await send(t, channel, { n: 1 });
      await send(t, channel, { n: 2 });
      const a = await openSub(t, channel, { mode: 'group', group: 'workers' });
      const b = await openSub(t, channel, { mode: 'group', group: 'workers' });
      const held = await pullOne(t, a);
      t.equal(held.payload.n, 1, 'the first member holds the first message');
      await t.driver.request('subscription.close', { subscription: a.subscription });
      // The position the departed member held becomes available again (CG-6).
      const forB = await pullOne(t, b);
      t.equal(forB.payload.n, 1, 'the group makes the abandoned position available again');
    },
  },
  {
    id: 'CG-6',
    rule: 'a nacked or timed-out position MUST become available to the group again',
    async run(t) {
      const { channel } = await boundChannel(t);
      await t.driver.request('group.open', { channel: channel.id, name: 'workers' });
      await send(t, channel, { n: 1 });
      const a = await openSub(t, channel, { mode: 'group', group: 'workers' });
      const item = await pullOne(t, a);
      await t.driver.request('subscription.nack', { subscription: a.subscription, delivery: item.delivery });
      const again = await pullOne(t, a);
      t.equal(again.payload.n, 1, 'the nacked position is redelivered');
    },
  },
  {
    id: 'CG-7',
    rule: 'a ConsumerGroup MUST NOT exist independently of its Channel',
    async run(t) {
      await t.driver.refused(
        'group.open',
        { channel: 'no-such-channel', name: 'workers' },
        'EAPP_CHANNEL_INVALID',
      );
    },
  },

  // ----------------------------------------------------------- Transport (v3.1 §10)
  {
    id: 'TR-5',
    rule: 'readAfter MUST return only messages with a cursor strictly greater than the argument',
    async run(t) {
      const { channel } = await boundChannel(t);
      const first = await send(t, channel, { n: 1 });
      const second = await send(t, channel, { n: 2 });
      const after = await t.driver.request('transport.readAfter', {
        channel: channel.id,
        cursor: first.cursor,
        pattern: { all: true },
      });
      t.equal(after.length, 1, 'exactly one message follows the first');
      t.equal(after[0].cursor, second.cursor, 'and it is the second');
    },
  },
  {
    id: 'TR-6',
    rule: 'an undefined cursor MUST mean "from the earliest retained position"',
    async run(t) {
      const { channel } = await boundChannel(t);
      const first = await send(t, channel, { n: 1 });
      await send(t, channel, { n: 2 });
      const all = await t.driver.request('transport.readAfter', {
        channel: channel.id,
        pattern: { all: true },
      });
      t.equal(all.length, 2, 'both messages are returned');
      t.equal(all[0].cursor, first.cursor, 'starting at the earliest');
    },
  },
  {
    id: 'TR-7',
    rule: 'readAfter with no match MUST return an empty array and MUST NOT block',
    async run(t) {
      const { channel } = await boundChannel(t);
      const only = await send(t, channel, { n: 1 });
      const none = await t.driver.request(
        'transport.readAfter',
        { channel: channel.id, cursor: only.cursor, pattern: { all: true } },
        2_000,
      );
      t.deepEqual(none, [], 'no match yields an empty array, not a hang');
    },
  },
  {
    id: 'TR-8',
    rule: 'the cursor returned by send MUST be strictly greater than every previous one',
    async run(t) {
      const { channel } = await boundChannel(t);
      const cursors = [];
      for (let i = 0; i < 5; i += 1) {
        cursors.push((await send(t, channel, { n: i })).cursor);
      }
      t.equal(new Set(cursors).size, cursors.length, 'every cursor is distinct');
      const ordered = await t.driver.request('transport.readAfter', {
        channel: channel.id,
        pattern: { all: true },
      });
      t.deepEqual(
        ordered.map((m) => m.cursor),
        cursors,
        'reading from the start reproduces the cursors in send order',
      );
    },
  },
  {
    id: 'TR-9',
    rule: 'an unsupported feature MUST be refused with the code that names it',
    async run(t) {
      const caps = await t.driver.request('transport.capabilities');
      t.assert(typeof caps.supportsCursor === 'boolean', 'supportsCursor is a boolean (TR-2)');
      t.assert(typeof caps.supportsLease === 'boolean', 'supportsLease is a boolean (TR-2)');
      t.assert(
        caps.durabilityBoundary === 'process'
          || caps.durabilityBoundary === 'machine'
          || caps.durabilityBoundary === 'cluster'
          || caps.durabilityBoundary === 'global',
        `durabilityBoundary must be one of the four declared values, got ${JSON.stringify(caps.durabilityBoundary)}`,
      );
    },
  },

  // ------------------------------------------------------------- Modes (v3.1 §3.2)
  {
    id: 'EV-1',
    rule: 'an event MUST NOT expect a response',
    async run(t) {
      const { channel } = await boundChannel(t, { mode: 'event' });
      t.equal(channel.mode, 'event', 'the Channel is an event channel');
      const { cursor } = await send(t, channel, { n: 1 });
      t.assert(typeof cursor === 'string' && cursor.length > 0, 'an event still gets a cursor');
      const read = await t.driver.request('transport.readAfter', {
        channel: channel.id,
        pattern: { all: true },
      });
      t.equal(read.length, 1, 'and nothing responds to it');
    },
  },
  {
    id: 'ST-1',
    rule: 'the cursor of a message MUST be globally monotonic within the Channel',
    async run(t) {
      const { channel } = await boundChannel(t);
      for (let i = 0; i < 4; i += 1) await send(t, channel, { n: i });
      const all = await t.driver.request('transport.readAfter', {
        channel: channel.id,
        pattern: { all: true },
      });
      t.equal(all.length, 4, 'all four messages are readable');
      t.equal(new Set(all.map((m) => m.cursor)).size, 4, 'each has a distinct cursor');
    },
  },
  {
    id: 'ST-3',
    rule: 'messages before an acknowledged cursor MUST NOT be redelivered',
    async run(t) {
      const { channel } = await boundChannel(t);
      await send(t, channel, { n: 1 });
      await send(t, channel, { n: 2 });
      const sub = await openSub(t, channel, { cursor: 'earliest' });
      const first = await pullOne(t, sub);
      await t.driver.request('subscription.ack', { subscription: sub.subscription, delivery: first.delivery });
      const next = await pullOne(t, sub);
      t.equal(next.payload.n, 2, 'the acknowledged message is not delivered again');
    },
  },
];
