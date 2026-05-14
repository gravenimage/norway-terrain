export const areaVertexShader = String.raw`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute vec3 aColor;
    uniform float uExag;
    uniform float uExtraLift;
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main(){
      vec3 p = position;
      p.z = p.z * uExag + uExtraLift;
      vNormal = normalize(normal);
      vColor = aColor;
      vWorld = p;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      #include <logdepthbuf_vertex>
    }`;

export const areaFragmentShader = String.raw`
    precision highp float;
    #include <common>
    #include <logdepthbuf_pars_fragment>
    varying vec3 vNormal;
    varying vec3 vColor;
    varying vec3 vWorld;
    uniform vec3 uSun;
    uniform vec3 uFogColor;
    uniform float uFogNear, uFogFar;
    uniform float uFadeNear, uFadeFar;
    void main(){
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vNormal);
      float diff = clamp(dot(N, normalize(uSun)), 0.0, 1.0);
      float wrap = 0.55 + 0.55 * diff;
      vec3 col = vColor * wrap;
      float dist = length(vWorld - cameraPosition);
      float fogF = smoothstep(uFogNear, uFogFar, dist);
      col = mix(col, uFogColor, fogF);
      float alpha = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(col, alpha);
    }`;

export const propVertexShader = String.raw`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute vec3 color;
    attribute vec3 iPos;
    attribute float iRot;
    attribute float iScale;
    uniform float uExag;
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main(){
      vec3 p = position * iScale;
      float c = cos(iRot), s = sin(iRot);
      vec2 r = vec2(c*p.x - s*p.y, s*p.x + c*p.y);
      p.x = r.x; p.y = r.y;
      p.x += iPos.x;
      p.y += iPos.y;
      p.z += iPos.z * uExag + 0.05;
      vec3 N = normal;
      vec2 nr = vec2(c*N.x - s*N.y, s*N.x + c*N.y);
      vNormal = normalize(vec3(nr, N.z));
      vColor = color;
      vWorld = p;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      #include <logdepthbuf_vertex>
    }`;

export const propFragmentShader = String.raw`
    precision highp float;
    #include <common>
    #include <logdepthbuf_pars_fragment>
    varying vec3 vNormal;
    varying vec3 vColor;
    varying vec3 vWorld;
    uniform vec3 uSun, uFogColor;
    uniform float uFogNear, uFogFar, uFadeNear, uFadeFar;
    void main(){
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vNormal);
      float d = clamp(dot(N, normalize(uSun)), 0.0, 1.0);
      // cartoonish 3-band toon
      float band = d > 0.65 ? 1.0 : (d > 0.30 ? 0.78 : 0.55);
      vec3 col = vColor * band;
      float dist = length(vWorld - cameraPosition);
      float fogF = smoothstep(uFogNear, uFogFar, dist);
      col = mix(col, uFogColor, fogF);
      float alpha = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(col, alpha);
    }`;
