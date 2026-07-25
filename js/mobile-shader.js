// Mobile shader background - replaces Three.js particles on phones
(function() {
    'use strict';
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobile) return;

    const canvas = document.createElement('canvas');
    canvas.id = 'mobile-shader-bg';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100vh;z-index:0;pointer-events:none;display:block;';
    document.body.insertBefore(canvas, document.body.firstChild);

    const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return;

    const VERT = `attribute vec2 a_position;void main(){gl_Position=vec4(a_position,0.0,1.0);}`;

    const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;#else
precision mediump float;#endif
uniform vec3 u_colors[8];
uniform vec4 u_scene;
uniform vec4 u_shape;
uniform vec4 u_surface;
uniform vec4 u_finish;
uniform vec4 u_transform;
uniform vec4 u_space;
#define u_resolution u_scene.xy
#define u_time u_scene.z
#define u_colorCount u_scene.w
#define u_scale u_shape.x
#define u_intensity u_shape.y
#define u_paramA u_shape.z
#define u_warp u_shape.w
#define u_detail u_surface.x
#define u_contrast u_surface.y
#define u_brightness u_surface.z
#define u_saturation u_surface.w
#define u_hue u_finish.x
#define u_vignette u_finish.y
#define u_blur u_finish.z
#define u_grain u_finish.w
#define u_seed u_transform.x
#define u_rotate u_transform.y
#define u_drift u_transform.z
#define u_offset u_space.xy
#define u_mouse u_space.zw
float hash21(vec2 p){p=fract(p*vec2(234.34,435.345));p+=dot(p,p+34.23);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hash21(i),hash21(i+vec2(1,0)),u.x),mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.0;float a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec2(17.0,9.2);a*=0.5;}return v;}
vec3 shade(vec2 uv,vec2 p,float t){vec3 acc=u_colors[0]*0.15;float total=0.15;for(int i=0;i<8;i++){if(float(i)>=u_colorCount)break;float fi=float(i);vec2 c=vec2(sin(t*(0.21+fi*0.071)+fi*2.4+u_seed),cos(t*(0.17+fi*0.093)+fi*1.7))*(0.45+u_intensity*0.35);float w=exp(-dot(p-c,p-c)*6.0);acc+=u_colors[i]*w;total+=w;}return acc/total;}
void main(){vec2 uv=gl_FragCoord.xy/u_resolution.xy;vec2 screenUv=uv;vec2 p=(gl_FragCoord.xy-0.5*u_resolution.xy)/min(u_resolution.x,u_resolution.y);uv=p*min(u_resolution.x,u_resolution.y)/u_resolution.xy+0.5;p*=u_scale;if(u_drift>0.0001)p+=u_drift*vec2(sin(u_time*0.31),cos(u_time*0.23));if(u_warp>0.0){p+=u_warp*(vec2(fbm(p*u_detail+u_seed),fbm(p*u_detail+vec2(5.2,1.3)))-0.5);}vec3 col=shade(uv,p,u_time);col=(col-0.5)*u_contrast+0.5;if(abs(u_brightness)>0.0001)col+=u_brightness;if(u_vignette>0.0001){float vd=length(screenUv-0.5)*1.41421356;col*=1.0-u_vignette*smoothstep(0.35,1.0,vd);}if(u_grain>0.0001)col+=(hash21(gl_FragCoord.xy+u_seed)-0.5)*u_grain;gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);}`;

    const UNIFORMS = {
        colors: [
            [0.011764705882352941, 0.07058823529411765, 0.054901960784313725],
            [0.054901960784313725, 0.48627450980392156, 0.35294117647058826],
            [0.48627450980392156, 0.8980392156862745, 0.4666666666666667],
            [0.9568627450980393, 1.0, 0.7803921568627451],
            [0.9568627450980393, 1.0, 0.7803921568627451],
            [0.9568627450980393, 1.0, 0.7803921568627451],
            [0.9568627450980393, 1.0, 0.7803921568627451],
            [0.9568627450980393, 1.0, 0.7803921568627451]
        ],
        colorCount: 4,
        scale: 1.160,
        intensity: 0.340,
        paramA: 0.500,
        warp: 0.000,
        detail: 2.400,
        contrast: 1.158,
        brightness: 0.150,
        saturation: 1.000,
        hue: 0.0000,
        vignette: 0.000,
        blur: 0.0000,
        grain: 0.091,
        seed: 1453.0,
        rotate: 0.0000,
        offsetX: 0.000,
        offsetY: 0.000,
        drift: 0.000
    };

    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('[MobileShader] Shader compile error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER, VERT);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, FRAG);
    if (!vertexShader || !fragmentShader) {
        console.error('[MobileShader] Failed to compile shaders');
        return;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('[MobileShader] Program link error:', gl.getProgramInfoLog(program));
        return;
    }

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const positionLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
        colors: gl.getUniformLocation(program, 'u_colors'),
        scene: gl.getUniformLocation(program, 'u_scene'),
        shape: gl.getUniformLocation(program, 'u_shape'),
        surface: gl.getUniformLocation(program, 'u_surface'),
        finish: gl.getUniformLocation(program, 'u_finish'),
        transform: gl.getUniformLocation(program, 'u_transform'),
        space: gl.getUniformLocation(program, 'u_space'),
    };

    gl.uniform3fv(uniforms.colors, new Float32Array(UNIFORMS.colors.flat()));
    gl.uniform4f(uniforms.shape, UNIFORMS.scale, UNIFORMS.intensity, UNIFORMS.paramA, UNIFORMS.warp);
    gl.uniform4f(uniforms.surface, UNIFORMS.detail, UNIFORMS.contrast, UNIFORMS.brightness, UNIFORMS.saturation);
    gl.uniform4f(uniforms.finish, UNIFORMS.hue, UNIFORMS.vignette, UNIFORMS.blur, UNIFORMS.grain);
    gl.uniform4f(uniforms.transform, UNIFORMS.seed, UNIFORMS.rotate, UNIFORMS.drift, 0.0);
    gl.uniform4f(uniforms.space, UNIFORMS.offsetX, UNIFORMS.offsetY, 0, 0);

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
    }

    const startTime = performance.now();
    let rafId = 0;

    function render() {
        rafId = 0;
        const now = performance.now();
        const t = ((now - startTime) / 1000) * 0.727;
        resize();
        gl.uniform4f(uniforms.scene, canvas.width, canvas.height, t, UNIFORMS.colorCount);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        rafId = requestAnimationFrame(render);
    }

    render();

    window.addEventListener('resize', resize);
})();
