// إدخال مخفي لكلمة المرور (بلا صدى). في بيئة غير تفاعلية يقرأ سطراً عادياً.
// (نسخة مطابقة لما في um-probe.mjs، فُصلت لتستعملها الأدوات الجديدة دون المساس بأداة الفحص العاملة.)
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; if (buf.includes('\n')) { stdin.pause(); resolve(buf.split('\n')[0].replace(/\r$/, '')); } });
      stdin.on('end', () => resolve(buf));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const finish = (fn, val) => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); fn(val); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(resolve, s);
        if (ch === '\u0003') return finish(reject, new Error('أُلغيت العملية'));
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on('data', onData);
  });
}
