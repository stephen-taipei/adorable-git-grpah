import * as THREE from 'three';
import { OUTLINE_COLOR } from '@adorable/graph-core';

export type Mouth = 'smile' | 'grin' | 'oh' | 'worry';

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function makeCanvas(w: number, h: number, draw: Draw): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx, w, h);
  return c;
}

function toTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 管理 scene 內所有 canvas 產生的貼圖，統一 dispose。 */
export class TextureKit {
  private readonly all: THREE.Texture[] = [];

  readonly toonGradient: THREE.DataTexture;
  readonly eyes: THREE.CanvasTexture;
  readonly pupils: THREE.CanvasTexture;
  readonly mouths: Record<Mouth, THREE.CanvasTexture>;
  readonly sprout: THREE.CanvasTexture;
  readonly crown: THREE.CanvasTexture;
  readonly sparkle: THREE.CanvasTexture;
  readonly sweat: THREE.CanvasTexture;
  readonly gloss: THREE.CanvasTexture;
  readonly dots: THREE.CanvasTexture;

  constructor() {
    const grad = new THREE.DataTexture(new Uint8Array([95, 165, 220, 255]), 4, 1, THREE.RedFormat);
    grad.minFilter = THREE.NearestFilter;
    grad.magFilter = THREE.NearestFilter;
    grad.needsUpdate = true;
    this.toonGradient = grad;
    this.all.push(grad);

    this.eyes = this.add(
      makeCanvas(256, 128, (ctx) => {
        for (const cx of [64, 192]) {
          ctx.fillStyle = OUTLINE_COLOR;
          ctx.beginPath();
          ctx.arc(cx, 64, 54, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(cx, 64, 46, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
    );
    this.pupils = this.add(
      makeCanvas(256, 128, (ctx) => {
        for (const cx of [64, 192]) {
          ctx.fillStyle = OUTLINE_COLOR;
          ctx.beginPath();
          ctx.arc(cx, 64, 27, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(cx - 8, 55, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(cx + 9, 76, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
    );

    const cheeks = (ctx: CanvasRenderingContext2D) => {
      ctx.fillStyle = 'rgba(255, 105, 140, 0.5)';
      for (const cx of [34, 222]) {
        ctx.beginPath();
        ctx.ellipse(cx, 62, 20, 12, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const stroke = (ctx: CanvasRenderingContext2D) => {
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.fillStyle = OUTLINE_COLOR;
      ctx.lineWidth = 11;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    };
    this.mouths = {
      smile: this.add(
        makeCanvas(256, 128, (ctx) => {
          cheeks(ctx);
          stroke(ctx);
          ctx.beginPath();
          ctx.arc(128, 30, 40, Math.PI * 0.16, Math.PI * 0.84);
          ctx.stroke();
        }),
      ),
      grin: this.add(
        makeCanvas(256, 128, (ctx) => {
          cheeks(ctx);
          stroke(ctx);
          ctx.beginPath();
          ctx.moveTo(84, 38);
          ctx.quadraticCurveTo(128, 38, 172, 38);
          ctx.quadraticCurveTo(168, 96, 128, 96);
          ctx.quadraticCurveTo(88, 96, 84, 38);
          ctx.closePath();
          ctx.fill();
          ctx.save();
          ctx.clip();
          ctx.fillStyle = '#ff7a9a';
          ctx.beginPath();
          ctx.ellipse(128, 100, 28, 20, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }),
      ),
      oh: this.add(
        makeCanvas(256, 128, (ctx) => {
          cheeks(ctx);
          ctx.fillStyle = OUTLINE_COLOR;
          ctx.beginPath();
          ctx.ellipse(128, 62, 20, 26, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ff7a9a';
          ctx.beginPath();
          ctx.ellipse(128, 74, 11, 10, 0, 0, Math.PI * 2);
          ctx.fill();
        }),
      ),
      worry: this.add(
        makeCanvas(256, 128, (ctx) => {
          cheeks(ctx);
          stroke(ctx);
          ctx.beginPath();
          ctx.moveTo(92, 70);
          ctx.bezierCurveTo(108, 52, 118, 84, 128, 66);
          ctx.bezierCurveTo(138, 48, 148, 80, 164, 62);
          ctx.stroke();
        }),
      ),
    };

    this.sprout = this.add(
      makeCanvas(128, 128, (ctx) => {
        ctx.lineCap = 'round';
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 16;
        ctx.beginPath();
        ctx.moveTo(64, 120);
        ctx.quadraticCurveTo(64, 80, 64, 64);
        ctx.stroke();
        const leaf = (dir: number) => {
          ctx.beginPath();
          ctx.moveTo(64, 70);
          ctx.bezierCurveTo(64 + dir * 6, 24, 64 + dir * 50, 14, 64 + dir * 58, 22);
          ctx.bezierCurveTo(64 + dir * 62, 62, 64 + dir * 36, 76, 64, 70);
          ctx.closePath();
          ctx.fillStyle = '#7bdc6b';
          ctx.fill();
          ctx.lineWidth = 9;
          ctx.lineJoin = 'round';
          ctx.stroke();
        };
        leaf(-1);
        leaf(1);
        ctx.strokeStyle = '#7bdc6b';
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(64, 118);
        ctx.lineTo(64, 70);
        ctx.stroke();
      }),
    );

    this.crown = this.add(
      makeCanvas(160, 128, (ctx) => {
        ctx.lineJoin = 'round';
        ctx.lineWidth = 11;
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.fillStyle = '#ffd23f';
        ctx.beginPath();
        ctx.moveTo(24, 104);
        ctx.lineTo(16, 38);
        ctx.lineTo(54, 66);
        ctx.lineTo(80, 24);
        ctx.lineTo(106, 66);
        ctx.lineTo(144, 38);
        ctx.lineTo(136, 104);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ff5d73';
        for (const [x, y] of [
          [80, 82],
          [48, 90],
          [112, 90],
        ] as const) {
          ctx.beginPath();
          ctx.arc(x, y, 7, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
    );

    this.sparkle = this.add(
      makeCanvas(128, 128, (ctx) => {
        ctx.fillStyle = '#fff6a8';
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 8;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(64, 8);
        ctx.quadraticCurveTo(70, 58, 120, 64);
        ctx.quadraticCurveTo(70, 70, 64, 120);
        ctx.quadraticCurveTo(58, 70, 8, 64);
        ctx.quadraticCurveTo(58, 58, 64, 8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }),
    );

    this.sweat = this.add(
      makeCanvas(96, 128, (ctx) => {
        ctx.fillStyle = '#8fdcff';
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 8;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(48, 10);
        ctx.bezierCurveTo(48, 40, 20, 62, 20, 86);
        ctx.arc(48, 86, 28, Math.PI, 0, true);
        ctx.bezierCurveTo(76, 62, 48, 40, 48, 10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.ellipse(38, 84, 6, 10, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }),
    );

    this.gloss = this.add(
      makeCanvas(128, 128, (ctx) => {
        const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 60);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.6, 'rgba(255,255,255,0.55)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(64, 64, 60, 60, 0, 0, Math.PI * 2);
        ctx.fill();
      }),
    );

    this.dots = this.add(
      makeCanvas(192, 64, (ctx) => {
        ctx.fillStyle = OUTLINE_COLOR;
        for (const x of [36, 96, 156]) {
          ctx.beginPath();
          ctx.arc(x, 32, 14, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
    );
  }

  private add(c: HTMLCanvasElement): THREE.CanvasTexture {
    const t = toTexture(c);
    this.all.push(t);
    return t;
  }

  dispose() {
    for (const t of this.all) t.dispose();
    this.all.length = 0;
  }
}
