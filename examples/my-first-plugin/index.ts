/**
 * EaPP — 写你的第一个插件。
 *
 * 本文件是 `docs/guides/write-a-plugin.md` §2 那段示例的可跑版本，位置也是指南写定的：
 * 下面的 `../../packages/...` 相对导入按这个深度写。
 *
 *   npx tsx examples/my-first-plugin/index.ts
 *   pnpm run example:first
 *
 * 它不只是"能跑"。指南引用了本文件的输出，并对你应当观察到什么做了若干断言；
 * 文件末尾会逐条核对它们，任何一条不成立就以非 0 退出。
 * 换句话说：这两个插件同时也是文档的测试。
 *
 * 演示 `examples/hello-plugins/` 覆盖的是三层全貌（含 event 与 state）。
 * 这一个刻意只走 request 模式，把精力放在"插件作者真正会写错的地方"：
 * 身份从哪来、能力版本算不算身份、invoke 的方向、错误码怎么浮现。
 */

import { EappError } from '../../packages/core/src/index.js';
import { EappRuntime, type PluginModule } from '../../packages/runtime/src/index.js';

const CASING = { name: 'casing.apply', version: '1.0.0' };
const GREETING = { name: 'greeting.render', version: '1.0.0' };

// ---------------------------------------------------------------------------
// 自检设施
//
// console.log 出来的东西被文档引用，肉眼可见；返回值、派生状态、错误码看不见，
// 也正是它们会悄悄跑偏。所以下面每一条"指南承诺的事实"都配一个 check。
// ---------------------------------------------------------------------------

const broken: string[] = [];
let checked = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  checked += 1;
  if (ok) return;
  broken.push(`${label}${detail === undefined ? '' : `（实际 ${JSON.stringify(detail)}）`}`);
}

/** 断言一次调用以指定 code 失败，并把错误对象交还给调用方继续核对。 */
async function failsWith(
  label: string,
  code: string,
  run: () => Promise<unknown>,
): Promise<EappError | undefined> {
  checked += 1;
  try {
    await run();
  } catch (error) {
    if (!(error instanceof EappError)) {
      broken.push(`${label}（抛出的是 ${String(error)}，不是 EappError）`);
      return undefined;
    }
    if (error.code !== code) {
      broken.push(`${label}（code 是 ${error.code}，期望 ${code}）`);
      return undefined;
    }
    return error;
  }
  broken.push(`${label}（没有失败，期望 ${code}）`);
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 两个互不相识的插件
//
// 没有一行 import 指向对方。它们之间只有运行时。
// ---------------------------------------------------------------------------

/** 提供 casing.apply：把任意输入变成大写。一个最小的纯提供方。 */
function casingPlugin(): PluginModule {
  return {
    manifest: {
      identity: { domain: 'acme.text', id: 'casing', instance: 'casing-1' },
      capabilities: [CASING],
    },
    handlers: {
      'casing.apply': async (payload) => String(payload).toUpperCase(),
    },
  };
}

/**
 * 提供 greeting.render，并且**在 handler 内部**去调用 casing.apply ——
 * 它要用到运行时，所以由外部注入一个函数；它自己不知道谁实现了 casing.apply。
 */
function greeterPlugin(applyCasing: (text: string) => Promise<string>): PluginModule {
  let active = false;
  let rendered = 0;

  return {
    manifest: {
      identity: { domain: 'acme.greeting', id: 'greeter', instance: 'greeter-1' },
      capabilities: [{ ...GREETING, contract: { name: 'GreetingPayload', version: '1.0.0' } }],
    },

    activate() {
      active = true;
      console.log('  [greeter] activate()');
    },
    async deactivate() {
      active = false;
    },

    handlers: {
      'greeting.render': async (payload, context) => {
        // context.caller 是本插件不需要知道的东西 —— 调用方是谁由运行时告诉它。
        const { name, upper = false, delayMs = 0 } = (payload ?? {}) as {
          name?: unknown;
          upper?: unknown;
          delayMs?: unknown;
        };
        if (typeof name !== 'string' || name.length === 0) {
          // 抛 EappError：code 会原样跨过 Channel 回到调用方（见 §7）。
          throw new EappError('EAPP_GREETING_INVALID_NAME', 'payload.name MUST be a non-empty string');
        }
        // delayMs 存在的唯一理由是让 §7 的"超时"断言真的可复现：
        // 要让 EAPP_TIMEOUT 出现，handler 的耗时必须明确大于 timeoutMs。
        if (typeof delayMs === 'number' && delayMs > 0) await sleep(delayMs);

        let line = `Hello, ${name}!`;
        if (upper === true) line = await applyCasing(line);
        if (!active) line += ' (inactive!)'; // 不该发生：DORMANT 的 binding 不会服务请求
        rendered += 1;
        return { line, total: rendered, correlationId: context.correlationId };
      },
    },
  };
}

async function main(): Promise<void> {
  const runtime = EappRuntime.create({ domain: 'eapp.guide' });

  // 先注册提供方，这样 greeter 的 handler 在调用时一定找得到它。
  const casing = runtime.register(casingPlugin());
  const greeter = runtime.register(
    greeterPlugin(async (text) => {
      const upper = await runtime.invoke({
        from: greeter, // 发起调用的一方（消费方）
        to: casing, // 能力提供方
        capability: CASING, // 只写 name/version，plugin 由运行时补上
        payload: text,
      });
      return String(upper);
    }),
  );
  const portal = runtime.register({
    manifest: {
      identity: { domain: 'acme.app', id: 'portal', instance: 'portal-1' },
      capabilities: [],
    },
  });

  // -------------------------------------------------------------------------
  console.log('\n写你的第一个插件 — my-first-plugin\n');

  // --- 发现：谁会做 greeting.render？ ---------------------------------------
  const found = await runtime.discover({ capability: 'greeting.render' });
  console.log('发现:', found.map((p) => p.id).join(', '));
  check('discover 找到 greeter', found.length === 1 && found[0]?.id === 'greeter', found.map((p) => p.id));

  // D-3：发现得到的是"可以被组合"，不是"已经可以调用"。
  check('发现不产生任何 Binding', runtime.core.listBindings().length === 0, runtime.core.listBindings().length);

  // ID-6：身份恰好是 domain/id/instance 三个字段，version 不在其中。
  check('身份不含 version', !('version' in greeter), Object.keys(greeter));
  check('身份是运行时铸造的', greeter.domain === 'acme.greeting' && greeter.id === 'greeter');

  // 能力版本是绑定身份的一部分（C-5）：2.0.0 与 1.0.0 是两个能力。
  const wrongVersion = await runtime.discover({ capability: 'casing.apply', version: '2.0.0' });
  check('版本是能力的一部分', wrongVersion.length === 0, wrongVersion.length);

  // --- 连接 ----------------------------------------------------------------
  // connect 的 from 是**提供方**，to 是消费方 —— 与 invoke 相反，见 §4 的说明。
  const { binding, channel } = await runtime.connect({
    from: greeter,
    to: portal,
    capability: GREETING,
    mode: 'request',
  });
  console.log('binding =', binding.id, '状态 =', runtime.core.bindingState(binding.id)); // DORMANT
  console.log('channel =', channel.id, channel.mode, channel.delivery, channel.state);

  check('连接后 Binding 是 DORMANT', runtime.core.bindingState(binding.id) === 'DORMANT');
  check('delivery 由 mode 推导', channel.delivery === 'at-most-once', channel.delivery);
  check('Channel 已 connect', channel.state === 'ACTIVE', channel.state);

  // --- 激活 ----------------------------------------------------------------
  await runtime.activate(casing);
  await runtime.activate(greeter);
  await runtime.activate(portal);
  console.log('激活后 binding 状态 =', runtime.core.bindingState(binding.id)); // ACTIVE

  check('两端 ACTIVE 后 Binding 派生出 ACTIVE', runtime.core.bindingState(binding.id) === 'ACTIVE');

  // --- 调用 ----------------------------------------------------------------
  const reply = await runtime.invoke({
    from: portal,
    to: greeter,
    capability: GREETING,
    payload: { name: 'Ada' },
  });
  console.log('reply:', JSON.stringify(reply));
  check('reply.line', (reply as { line: string }).line === 'Hello, Ada!', reply);

  const upper = await runtime.invoke({
    from: portal,
    to: greeter,
    capability: GREETING,
    payload: { name: 'Grace', upper: true },
  });
  console.log('handler 内部再调用:', JSON.stringify(upper));
  check('嵌套调用跨了两条 Channel', (upper as { line: string }).line === 'HELLO, GRACE!', upper);
  check('两个调用各有自己的 correlationId',
    (reply as { correlationId: string }).correlationId !== (upper as { correlationId: string }).correlationId);

  // -------------------------------------------------------------------------
  // 错误如何浮现（§7）。下面每一行都是指南里那张表的实体。
  // -------------------------------------------------------------------------
  console.log('\n错误如何浮现');

  const invalid = await failsWith('handler 抛 EappError', 'EAPP_GREETING_INVALID_NAME', () =>
    runtime.invoke({ from: portal, to: greeter, capability: GREETING, payload: { name: '' } }),
  );
  console.log('  payload.name = ""          ->', invalid?.code, `retryable=${String(invalid?.retryable)}`);
  check('自定义码默认不可重试', invalid?.retryable === false);

  // 指南规定：要让 EAPP_TIMEOUT 出现，handler 的耗时必须明确大于 timeoutMs。
  const timedOut = await failsWith('handler 慢于 timeoutMs', 'EAPP_TIMEOUT', () =>
    runtime.invoke({
      from: portal,
      to: greeter,
      capability: GREETING,
      payload: { name: 'Slow', delayMs: 40 },
      timeoutMs: 5,
    }),
  );
  console.log('  handler 睡 40ms, timeoutMs 5 ->', timedOut?.code, `retryable=${String(timedOut?.retryable)}`);
  check('EAPP_TIMEOUT 不可重试', timedOut?.retryable === false);

  // 方向写反：这样问等于要求 portal 提供 casing.apply，而它什么都不提供。
  const reversed = await failsWith('invoke 的 from/to 写反', 'EAPP_CAPABILITY_NOT_EXPOSED', () =>
    runtime.invoke({ from: casing, to: greeter, capability: CASING, payload: 'x' }),
  );
  console.log('  invoke 的 from/to 写反       ->', reversed?.code);

  // 声明了能力、却没有对应的 handler：Binding 建得起来，服务不了。
  const mute = runtime.register({
    manifest: {
      identity: { domain: 'acme.greeting', id: 'mute', instance: 'mute-1' },
      capabilities: [GREETING],
    },
  });
  await runtime.activate(mute);
  const unimplemented = await failsWith('声明了能力但没有 handler', 'EAPP_CAPABILITY_NOT_EXPOSED', () =>
    runtime.invoke({ from: portal, to: mute, capability: GREETING, payload: { name: 'x' } }),
  );
  console.log('  声明了能力但没有 handler     ->', unimplemented?.code);

  const missing = await failsWith('目标插件没注册', 'EAPP_PLUGIN_NOT_FOUND', () =>
    runtime.invoke({
      from: portal,
      to: { domain: 'acme.greeting', id: 'ghost', instance: 'ghost-1' },
      capability: GREETING,
      payload: { name: 'x' },
    }),
  );
  console.log('  目标插件没注册               ->', missing?.code);

  const duplicate = await failsWith('同一身份注册两次', 'EAPP_IDENTITY_DUPLICATE', async () => {
    runtime.register(casingPlugin());
  });
  console.log('  同一身份注册两次             ->', duplicate?.code);

  // §8：插件 MUST NOT 自己签发身份，也不该指望没声明的钩子存在。
  const greeterModule = greeterPlugin(async (t) => t);
  check('PluginModule 没有 onEvent 钩子', !('onEvent' in greeterModule));
  check('casing 不知道 greeter 的存在', !Object.keys(casingPlugin()).includes('greeter'));

  await runtime.shutdown();

  // -------------------------------------------------------------------------
  console.log('');
  if (broken.length > 0) {
    console.error(`\x1b[31m自检失败 ${broken.length}/${checked}\x1b[0m`);
    for (const item of broken) console.error(`  ✗ ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log(`自检: ${checked} 条断言全部通过`);
}

main().catch((error: unknown) => {
  console.error('\n\x1b[31mmy-first-plugin 失败\x1b[0m');
  console.error(error);
  process.exitCode = 1;
});
