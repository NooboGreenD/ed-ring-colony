'use client';
import { useEffect, useRef } from 'react';
export default function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let w = (canvas.width = canvas.offsetWidth);
    let h = (canvas.height = canvas.offsetHeight);
    const colors = ['#eeeeee', '#eeeeee', '#eeeeee', '#e67e22', '#3498db', '#9ca3af'];
    const stars = Array.from({ length: 150 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      s: Math.random() * 2.2 + 0.6,
      c: colors[Math.floor(Math.random() * colors.length)],
      p: Math.random() * Math.PI * 2,
      v: 0.008 + Math.random() * 0.02,
    }));
    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const st of stars) {
        st.p += st.v;
        ctx.globalAlpha = 0.35 + Math.abs(Math.sin(st.p)) * 0.65;
        ctx.fillStyle = st.c;
        ctx.fillRect(st.x, st.y, st.s, st.s);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    const onResize = () => {
      w = canvas.width = canvas.offsetWidth;
      h = canvas.height = canvas.offsetHeight;
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}