// أخذ قراءة كاملة من الراوتر. إما قراءة كاملة وصالحة أو استثناء: لا قراءة جزئية ولا أصفار بديلة.
import { readSystem, discoverInterfaces } from './routeros-api.js';
import { makeReading } from './counters.js';

export async function takeReading(client, nowMs = Date.now()) {
  const system = await readSystem(client);
  const { interfaces, warnings } = await discoverInterfaces(client);
  const reading = makeReading({ ts: nowMs, uptimeSec: system.uptimeSec, ifaces: interfaces });
  return { reading, system, interfaces, warnings };
}
