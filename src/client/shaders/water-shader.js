export const vertexShader = String.raw`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    uniform float uExag;
    varying vec3 vWorld;
    varying float vDepthFade;
    void main(){
      vec3 p = position;
      p.z = p.z * uExag + 0.3;
      vec4 wp = modelMatrix * vec4(p, 1.0);
      vWorld = wp.xyz;
      vDepthFade = clamp(p.z / 200.0, 0.0, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }
  `;

export const fragmentShader = String.raw`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    uniform vec3 uSun;
    varying vec3 vWorld;
    varying float vDepthFade;
    void main(){
      #include <logdepthbuf_fragment>
      vec3 dx = dFdx(vWorld);
      vec3 dy = dFdy(vWorld);
      vec3 n = normalize(cross(dx, dy));
      float ndl = max(dot(n, normalize(uSun)), 0.0);
      vec3 deep    = vec3(0.06, 0.20, 0.36);
      vec3 shallow = vec3(0.18, 0.42, 0.55);
      vec3 base = mix(deep, shallow, vDepthFade);
      vec3 col = base * (0.55 + 0.45 * ndl);
      gl_FragColor = vec4(col, 1.0);
    }
  `;
