import * as THREE from 'three';
import { OUTLINE_COLOR } from '@adorable/graph-core';

export interface SharedUniforms {
  uTime: { value: number };
}

const RIBBON_VERT = /* glsl */ `
attribute float aU;
attribute float aV;
varying float vU;
varying float vV;
void main() {
  vU = aU;
  vV = aV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** 管線：深色描邊 + 彩色內部 + 沿時間軸流動的箭頭（>）。 */
const RIBBON_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uOutline;
uniform float uTime;
uniform float uReveal;
uniform float uChevron;
uniform float uDash;
uniform float uAlpha;
varying float vU;
varying float vV;
void main() {
  if (uReveal <= 0.0 || vU >= uReveal) discard;
  if (uDash > 0.5 && fract(vU * 1.8) > 0.5) discard;
  float av = abs(vV);
  float aa = fwidth(vV) * 1.5;
  float border = smoothstep(0.58 - aa, 0.58 + aa, av);
  float period = 1.15;
  float d = fract((vU - uTime * 0.9) / period + av * 0.34);
  float chev = smoothstep(0.0, 0.03, d) * (1.0 - smoothstep(0.17, 0.21, d));
  vec3 inner = mix(uColor, vec3(1.0), chev * 0.6 * uChevron);
  // 上緣一條淡淡的高光，像塑膠管
  float shine = smoothstep(0.1, 0.35, vV) * (1.0 - smoothstep(0.35, 0.5, vV));
  inner = mix(inner, vec3(1.0), shine * 0.28);
  vec3 col = mix(inner, uOutline, border);
  gl_FragColor = vec4(col, uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createRibbonMaterial(
  shared: SharedUniforms,
  color: string,
  opts: { chevron?: boolean; dash?: boolean; alpha?: number } = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOutline: { value: new THREE.Color(OUTLINE_COLOR) },
      uTime: shared.uTime,
      uReveal: { value: 0 },
      uChevron: { value: opts.chevron === false ? 0 : 1 },
      uDash: { value: opts.dash ? 1 : 0 },
      uAlpha: { value: opts.alpha ?? 1 },
    },
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    transparent: opts.alpha !== undefined && opts.alpha < 1,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
}

/** 跟著鏡頭走、但以 world 座標畫點點的「方格紙」底圖。 */
export function createGridMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#8a7fb8') },
      uAlpha: { value: 0.28 },
      uSize: { value: 1.35 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uSize;
      varying vec2 vWorld;
      void main() {
        vec2 g = fract(vWorld / uSize) - 0.5;
        float d = length(g);
        float w = fwidth(d) * 1.2;
        float a = 1.0 - smoothstep(0.045 - w, 0.045 + w, d);
        gl_FragColor = vec4(uColor, a * uAlpha);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    // 透明物件一律在不透明物件之後繪製，所以背景要靠 depthTest（z 在最後面）才不會蓋住 node。
    depthWrite: false,
    depthTest: true,
  });
}
