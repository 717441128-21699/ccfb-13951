import { FmDemodulator } from '../src/dsp/demod';
const FS = 12000;
const demod = new FmDemodulator(FS);
for (const target of [1200, 1500, 1900, 2300]) {
  const n = FS * 0.2;
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = Math.sin((2*Math.PI*target*i)/FS);
  const out = new Float32Array(n);
  demod.process(input, out);
  demod.reset();
  const tail = out.subarray(FS*0.05);
  const mean = tail.reduce((a,b)=>a+b,0)/tail.length;
  const v = tail.reduce((a,b)=>a+(b-mean)**2,0)/tail.length;
  console.log(target, '=> mean', mean.toFixed(1), 'std', Math.sqrt(v).toFixed(2));
}
