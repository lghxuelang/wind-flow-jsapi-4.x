define(["exports", "esri/request", "esri/Map", "esri/geometry/Extent", "esri/views/SceneView", "esri/views/3d/externalRenderers"],
    function (exports, request, Map, Extent, SceneView, externalRenderers) {
        Object.defineProperty(exports, "__esModule", { value: true });
        var view;
        var ParticleSystem = (function () {
            function ParticleSystem(properties) {
                // Settings
                this.numParticlesInTrail = 32;
                this.numParticleStreams = 1024 * 1024 / this.numParticlesInTrail;
                this.useLines = true;
                this.timestep = 1 / 60;
                // Precomputed
                this.totalNumParticles = this.numParticleStreams * this.numParticlesInTrail;
                this.particlePotSize = 1 << Math.ceil(Math.log(Math.sqrt(this.totalNumParticles)) / Math.LN2);
                // Particle simulation
                this.time = 0;
                this.gl = properties.gl;
                this.view = properties.view;
                this.extent = properties.extent;
                this.velocityFieldTexture = properties.velocityField;
                this.reprojectionTexture = properties.reprojection;
                this.initializeResources();
            }
            /**
             * Initialize all the GPU resources for running the particle
             * simulation and rendering the particles.
             */
            ParticleSystem.prototype.initializeResources = function () {
                this.initializeSimulationFBO();
                this.initializeQuadGeometryVBO();
                this.initializeParticleGeometryVBO();
                this.initializePrograms();
                this.initializeParticles();
            };
            /**
             * Creates the FBO used to run the simulation.
             */
            ParticleSystem.prototype.initializeSimulationFBO = function () {
                var gl = this.gl;
                this.simulationFBO = gl.createFramebuffer();
            };
            ParticleSystem.prototype.createRenderTexture = function () {
                var gl = this.gl;
                var renderTexture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, renderTexture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.view.width, this.view.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                return renderTexture;
            };
            /**
             * Initialize the VBO geometry used to run the particle simulation.
             * This is simply a quad (using a triangle strip) which covers the
             * texture that contains the particle state.
             */
            ParticleSystem.prototype.initializeQuadGeometryVBO = function () {
                var gl = this.gl;
                this.quadGeometryVBO = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.quadGeometryVBO);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
            };
            /**
             * Initialize attributes in a VBO buffer for a single particle.
             */
            ParticleSystem.prototype.initializeParticleAttributes = function (particleData, i, offset) {
                var x = i % this.particlePotSize;
                var y = Math.floor(i / this.particlePotSize);
                particleData[offset + 0] = (x + 0.5) / this.particlePotSize;
                particleData[offset + 1] = (y + 0.5) / this.particlePotSize;
                particleData[offset + 2] = (i % this.numParticleStreams) / this.numParticleStreams * 2 * Math.PI;
                particleData[offset + 3] = (Math.floor(i / this.numParticleStreams) + 1) / this.numParticlesInTrail;
            };
            /**
             * Create VBO containing geometry attributes for rendering particles. Particles
             * may be rendered either as points or as connected lines, depending on useLines.
             */
            ParticleSystem.prototype.initializeParticleGeometryVBO = function () {
                if (this.useLines) {
                    this.initializeParticleVBOLines();
                }
                else {
                    this.initializeParticleVBOPoints();
                }
            };
            /**
             * Create VBO containing geometry attributes for rendering particles
             * as lines.
             */
            ParticleSystem.prototype.initializeParticleVBOLines = function () {
                var gl = this.gl;
                var vertexPairs = (this.numParticlesInTrail - 1) * 2;
                var particleData = new Float32Array(vertexPairs * this.numParticleStreams * 4);
                var ptr = 0;
                for (var i = 0; i < this.numParticleStreams; i++) {
                    for (var j = 0; j < this.numParticlesInTrail - 1; j++) {
                        var idx = j * this.numParticleStreams + i;
                        var nextIdx = idx + this.numParticleStreams;
                        this.initializeParticleAttributes(particleData, idx, ptr);
                        ptr += 4;
                        this.initializeParticleAttributes(particleData, nextIdx, ptr);
                        ptr += 4;
                    }
                }
                this.particleGeometryVBO = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.particleGeometryVBO);
                gl.bufferData(gl.ARRAY_BUFFER, particleData, gl.STATIC_DRAW);
            };
            /**
             * Create VBO containing geometry attributes for rendering particles
             * as points.
             */
            ParticleSystem.prototype.initializeParticleVBOPoints = function () {
                var gl = this.gl;
                var particleData = new Float32Array(this.totalNumParticles * 4);
                var ptr = 0;
                for (var i = 0; i < this.totalNumParticles; i++) {
                    this.initializeParticleAttributes(particleData, i, ptr);
                    ptr += 4;
                }
                this.particleGeometryVBO = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.particleGeometryVBO);
                gl.bufferData(gl.ARRAY_BUFFER, particleData, gl.STATIC_DRAW);
            };
            ParticleSystem.prototype.initializePrograms = function () {
                this.programs = {
                    update: {
                        program: this.createProgram("update",
                            // Vertex shader
                            "\n            precision highp float;\n\n            attribute vec3 pos;\n            varying vec3 particlePosition;\n\n            void main() {\n              particlePosition = pos;\n              gl_Position = vec4((pos.xy * 2.0) - 1.0, 0, 1);\n            }\n          ",
                            // Fragment shader
                            "\n            precision highp float;\n            precision highp sampler2D;\n\n            varying vec3 particlePosition;\n\n            uniform sampler2D particles;\n\n            //uniform sampler2D velocityFieldX;\n            //uniform sampler2D velocityFieldY;\n            uniform sampler2D velocityField;\n            uniform sampler2D particleOriginsTexture;\n\n            uniform float timestep;\n            uniform float time;\n\n            // uniform float velocityOffset;\n            // uniform float velocityScale;\n\n            uniform vec2 velocityOffset;\n            uniform vec2 velocityScale;\n\n            const float trailSize = float(" + this.numParticlesInTrail + ");\n\n            float random(vec2 co) {\n              return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);\n            }\n\n            float rgba2float(vec4 rgba) {\n\t\t          return dot(rgba, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));\n\t          }\n\n            void main() {\n              vec4 particle = texture2D(particles, particlePosition.xy);\n\n              // Check if particle is even alive\n              if (particle.z < 0.0) {\n                if (-particle.z <= time) {\n                  // Should become alive and die after some time\n                  particle.z = time;\n                }\n              }\n              // Check if particle is now dead\n              else {\n                float lifeSpan = 10.0 + random(vec2(particle.z, -particle.z)) * 10.0;\n                float elapsed = time - particle.z;\n                float remaining = lifeSpan - elapsed;\n\n                float delay = timestep * trailSize * 5.0;\n\n                if (elapsed >= lifeSpan) {\n                  // Reposition it on the grid, based on some randomization\n                  particle.xy = texture2D(particleOriginsTexture, particlePosition.xy).xy;\n\n                  // Create a random time-to-life\n                  particle.z = -(time + 1.0 + random(particle.xy + vec2(time, time)) * 2.0);\n                }\n                // Otherwise just update the particle position according to the velocity field\n                else if (elapsed > particle.w * delay && remaining > (1.0 - particle.w) * delay) {\n                  vec2 velocity = texture2D(velocityField, particle.xy).xy * velocityScale + velocityOffset;\n\n                  const float velocityTimeScale = 0.0005;\n                  vec2 vupdate = vec2(velocity.x, -velocity.y) * timestep * velocityTimeScale;\n\n                  particle.xy += vupdate;\n                }\n              }\n\n              gl_FragColor = particle;\n            }\n          "),
                        uniforms: null
                    },
                    render: {
                        program: this.createProgram("render",
                            // Vertex shader
                            "\n            precision highp float;\n            precision highp sampler2D;\n\n            uniform sampler2D particles;\n\n            uniform sampler2D reprojectionX;\n            uniform sampler2D reprojectionY;\n            uniform sampler2D reprojectionZ;\n\n            uniform float reprojectionOffset;\n            uniform float reprojectionScale;\n\n            uniform mat4 viewMatrix;\n            uniform mat4 projectionMatrix;\n            uniform float time;\n\n\n            attribute vec2 position;\n            attribute float age;\n\n            varying float fAge;\n            varying vec4 particle;\n\n            float rgba2float(vec4 rgba) {\n\t\t          return dot(rgba, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));\n\t          }\n\n            float random(vec2 co) {\n              return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);\n            }\n\n            void main() {\n              particle = texture2D(particles, position);\n\n              float lifeSpan = 10.0 + random(vec2(particle.z, -particle.z)) * 5.0;\n              float elapsed = time - particle.z;\n              float remaining = lifeSpan - elapsed;\n\n              fAge = smoothstep(0.0, 2.0, remaining) * (age + 0.5) * 0.75;\n\n              gl_PointSize = 1.0 + fAge;\n\n              if (particle.z < 0.0) {\n                // Not alive, clip?\n                gl_Position = vec4(-2, -2, -2, 1);\n              }\n              else {\n                vec4 posX = texture2D(reprojectionX, particle.xy);\n                vec4 posY = texture2D(reprojectionY, particle.xy);\n                vec4 posZ = texture2D(reprojectionZ, particle.xy);\n\n                vec3 pos = vec3(rgba2float(posX), rgba2float(posY), rgba2float(posZ)) * reprojectionScale + reprojectionOffset;\n\n                vec4 ndcPos = projectionMatrix * viewMatrix * vec4(pos, 1);\n\n                // Add a constant z-bias to push the points towards the viewer, so\n                // we don't z-fight with the terrain\n                ndcPos.z -= 0.0001 * ndcPos.w;\n\n                gl_Position = ndcPos;\n              }\n            }\n          ",
                            // Fragment shader
                            "\n            precision highp float;\n            precision highp sampler2D;\n\n            uniform sampler2D velocityField;\n            uniform float time;\n            uniform vec2 velocityScale;\n            uniform vec2 velocityOffset;\n\n            varying vec4 particle;\n            varying float fAge;\n\n            void main() {\n              vec3 velocity = texture2D(velocityField, particle.xy).xyz;\n              gl_FragColor = vec4(velocity.xyz, fAge);\n            }\n          "),
                        uniforms: null
                    }
                };
                this.programs.update.uniforms = this.extractUniforms(this.programs.update.program, [
                    "particles", "velocityField", "velocityScale", "velocityOffset", "time", "timestep", "particleOriginsTexture"
                ]);
                this.programs.render.uniforms = this.extractUniforms(this.programs.render.program, [
                    "particles", "reprojectionX", "reprojectionY", "reprojectionZ", "reprojectionScale", "reprojectionOffset", "viewMatrix", "projectionMatrix", "velocityField", "velocityScale", "velocityOffset", "time"
                ]);
            };
            ParticleSystem.prototype.extractUniforms = function (program, names) {
                var ret = {};
                var gl = this.gl;
                for (var _i = 0, names_1 = names; _i < names_1.length; _i++) {
                    var name_1 = names_1[_i];
                    ret[name_1] = gl.getUniformLocation(program, name_1);
                }
                return ret;
            };
            ParticleSystem.prototype.randomPositionOnSphere = function () {
                var theta = Math.random() * Math.PI * 2;
                var phi = Math.acos(1 - 2 * Math.random());
                var x = Math.sin(phi) * Math.cos(theta);
                var y = Math.sin(phi) * Math.sin(theta);
                var z = Math.cos(phi);
                var coord = [0, 0, 0];
                externalRenderers.fromRenderCoordinates(this.view, [x * 6378137, y * 6378137, z * 6378137], 0, coord, 0, this.view.spatialReference, 1);
                return [
                    (coord[0] - this.extent.xmin) / this.extent.width,
                    (coord[1] - this.extent.ymin) / this.extent.height
                ];
            };
            ParticleSystem.prototype.initializeParticles = function () {
                var ptr = 0;
                var particleData = new Float32Array(this.particlePotSize * this.particlePotSize * 4);
                // Generate initial particle positions
                for (var i = 0; i < this.numParticleStreams; i++) {
                    var _a = this.randomPositionOnSphere(), x = _a[0], y = _a[1];
                    var timeToBirth = Math.random() * 20;
                    for (var j = 0; j < this.numParticlesInTrail; j++) {
                        var offset = j * this.numParticleStreams * 4;
                        particleData[ptr + offset + 0] = x;
                        particleData[ptr + offset + 1] = y;
                        // TTB (time to birth), in seconds
                        particleData[ptr + offset + 2] = -timeToBirth;
                        // Normalized trail delay
                        particleData[ptr + offset + 3] = 1 - (j + 1) / this.numParticlesInTrail;
                    }
                    ptr += 4;
                }
                this.particleOriginsTexture = this.createFloatTexture(particleData, this.particlePotSize);
                this.particleStateTextures = [
                    this.createFloatTexture(particleData, this.particlePotSize),
                    this.createFloatTexture(null, this.particlePotSize)
                ];
            };
            ParticleSystem.prototype.programLog = function (name, info) {
                if (info) {
                    console.error("Failed to compile or link", name, info);
                }
            };
            ParticleSystem.prototype.renderQuadGeometryVBO = function (context) {
                var gl = context.gl;
                // Setup draw geometrysimulationGeometryVBO
                gl.enableVertexAttribArray(0);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.quadGeometryVBO);
                gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
                // Finally, draw
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            };
            ParticleSystem.prototype.createProgram = function (name, vertex, fragment) {
                var gl = this.gl;
                var program = gl.createProgram();
                var vertexShader = gl.createShader(gl.VERTEX_SHADER);
                var fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
                gl.shaderSource(vertexShader, vertex);
                gl.compileShader(vertexShader);
                this.programLog(name + " - vertex", gl.getShaderInfoLog(vertexShader));
                gl.shaderSource(fragmentShader, fragment);
                gl.compileShader(fragmentShader);
                this.programLog(name + " - fragment", gl.getShaderInfoLog(fragmentShader));
                gl.attachShader(program, vertexShader);
                gl.attachShader(program, fragmentShader);
                gl.linkProgram(program);
                this.programLog(name + " - link program", gl.getProgramInfoLog(program));
                return program;
            };
            ParticleSystem.prototype.createFloatTexture = function (data, size) {
                var gl = this.gl;
                var texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.FLOAT, data);
                return texture;
            };
            ParticleSystem.prototype.update = function (context) {
                this.time += this.timestep;
                var gl = this.gl;
                // Bind input textures
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.particleStateTextures[0]);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.velocityFieldTexture.texture);
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, this.particleOriginsTexture);
                // Setup FBO
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.simulationFBO);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.particleStateTextures[1], 0);
                gl.viewport(0, 0, this.particlePotSize, this.particlePotSize);
                gl.disable(gl.BLEND);
                gl.disable(gl.DEPTH_TEST);
                gl.depthMask(false);
                // Setup program and uniforms
                var program = this.programs.update;
                gl.useProgram(program.program);
                gl.uniform1i(program.uniforms["particles"], 0);
                gl.uniform1i(program.uniforms["velocityField"], 1);
                gl.uniform1i(program.uniforms["particleOriginsTexture"], 2);
                gl.uniform2f(program.uniforms["velocityScale"], this.velocityFieldTexture.scaleU, this.velocityFieldTexture.scaleV);
                gl.uniform2f(program.uniforms["velocityOffset"], this.velocityFieldTexture.offsetU, this.velocityFieldTexture.offsetV);
                gl.uniform1f(program.uniforms["time"], this.time);
                gl.uniform1f(program.uniforms["timestep"], this.timestep);
                this.renderQuadGeometryVBO(context);
                // When update is done, swap the I/O textures
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
                _a = [this.particleStateTextures[1], this.particleStateTextures[0]], this.particleStateTextures[0] = _a[0], this.particleStateTextures[1] = _a[1];
                gl.viewport(0, 0, context.camera.fullWidth, context.camera.fullHeight);
                var _a;
            };
            ParticleSystem.prototype.renderParticles = function (context) {
                var gl = context.gl;
                // Bind input texture
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.particleStateTextures[0]);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.reprojectionTexture.textures[0]);
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, this.reprojectionTexture.textures[1]);
                gl.activeTexture(gl.TEXTURE3);
                gl.bindTexture(gl.TEXTURE_2D, this.reprojectionTexture.textures[2]);
                gl.activeTexture(gl.TEXTURE4);
                gl.bindTexture(gl.TEXTURE_2D, this.velocityFieldTexture.texture);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.enable(gl.DEPTH_TEST);
                gl.depthMask(false);
                // Setup program and uniforms
                var program = this.programs.render;
                gl.useProgram(program.program);
                gl.uniform1i(program.uniforms["particles"], 0);
                gl.uniform1i(program.uniforms["reprojectionX"], 1);
                gl.uniform1i(program.uniforms["reprojectionY"], 2);
                gl.uniform1i(program.uniforms["reprojectionZ"], 3);
                gl.uniform1i(program.uniforms["velocityField"], 4);
                gl.uniform2f(program.uniforms["velocityScale"], this.velocityFieldTexture.scaleU, this.velocityFieldTexture.scaleV);
                gl.uniform2f(program.uniforms["velocityOffset"], this.velocityFieldTexture.offsetU, this.velocityFieldTexture.offsetV);
                gl.uniform1f(program.uniforms["reprojectionScale"], this.reprojectionTexture.scale);
                gl.uniform1f(program.uniforms["reprojectionOffset"], this.reprojectionTexture.offset);
                gl.uniformMatrix4fv(program.uniforms["viewMatrix"], false, context.camera.viewMatrix);
                gl.uniformMatrix4fv(program.uniforms["projectionMatrix"], false, context.camera.projectionMatrix);
                gl.uniform1f(program.uniforms["time"], this.time);
                gl.uniform1f(program.uniforms["timestep"], this.timestep);
                // Setup draw geometry
                gl.enableVertexAttribArray(0);
                gl.enableVertexAttribArray(1);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.particleGeometryVBO);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
                gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
                // Finally, draw
                if (this.useLines) {
                    gl.drawArrays(gl.LINES, 0, (this.numParticlesInTrail - 1) * 2 * this.numParticleStreams);
                }
                else {
                    gl.drawArrays(gl.POINTS, 0, this.totalNumParticles);
                }
                gl.disableVertexAttribArray(0);
                gl.disableVertexAttribArray(1);
            };
            ParticleSystem.prototype.render = function (context) {
                context.bindRenderTarget();
                this.renderParticles(context);
                context.resetWebGLState();
            };
            return ParticleSystem;
        }());
        var ExternalRenderer = (function () {
            function ExternalRenderer(view) {
                var _this = this;
                this.view = view;
                this.readyToRender = false;
                this.paused = false;
                this.singleStep = false;
                view.on("pointer-down", function () { //鼠标按下一段时间切换风流动状态
                    _this.paused = !_this.paused;
                    console.log("paused", _this.paused);
                    if (!_this.paused) {
                        externalRenderers.requestRender(view);
                    }
                });
                view.on("pointer-up", function () {
                    if (_this.paused) {
                        _this.paused = false;
                        console.log("paused", _this.paused);
                        _this.singleStep = true;
                        externalRenderers.requestRender(view);
                    }
                });
            }
            ExternalRenderer.prototype.setup = function (context) {
                var _this = this;
                var gl = context.gl;
                gl.getExtension("OES_texture_float");
                this.prepareResources(context)
                    .then(function () {
                        _this.readyToRender = true;
                        externalRenderers.requestRender(_this.view);
                        console.log("going to render");
                    });
            };
            ExternalRenderer.prototype.renderTransparent = function (context) {
                if (!this.readyToRender) {
                    return;
                }
                if (this.particleSystem) {
                    if (!this.paused) {
                        this.particleSystem.update(context);
                    }
                    this.particleSystem.render(context);
                    if (this.singleStep) {
                        console.log("stepped");
                        this.paused = true;
                        this.singleStep = false;
                    }
                }
                context.resetWebGLState();
                if (!this.paused) {
                    externalRenderers.requestRender(this.view);
                }
            };
            ExternalRenderer.prototype.prepareResources = function (context) {
                var _this = this;
                var rasterInfo;
                return this.fetchRaster()
                    .then(function (fetchedRaster) {
                        rasterInfo = fetchedRaster;
                        _this.createTextures(context, fetchedRaster);
                    })
                    .then(function () {
                        _this.createParticleSystem(context, rasterInfo.extent);
                    });
            };
            ExternalRenderer.prototype.createParticleSystem = function (context, extent) {
                this.particleSystem = new ParticleSystem({
                    gl: context.gl,
                    view: this.view,
                    extent: extent,
                    velocityField: this.velocityField,
                    reprojection: this.reprojection
                });
            };
            ExternalRenderer.prototype.encodeFloatRGBA = function (value, rgba, offset) {
                var r = value % 1;
                var g = (value * 255) % 1;
                var b = (value * 65025) % 1;
                var a = (value * 16581375) % 1;
                rgba[offset] = r * 255 - g;
                rgba[offset + 1] = g * 255 - b;
                rgba[offset + 2] = b * 255 - a;
                rgba[offset + 3] = a * 255;
            };
            ExternalRenderer.prototype.decodeFloatRGBA = function (rgba, offset) {
                var r = rgba[offset + 0];
                var g = rgba[offset + 1];
                var b = rgba[offset + 2];
                var a = rgba[offset + 3];
                return r / 255 + g / 65025 + b / 16581375 + a / 4228250625;
            };
            //图片根据extent做投影
            ExternalRenderer.prototype.createReprojectionData = function (extent, resolution) {
                if (resolution === void 0) { resolution = 512; }
                var size = resolution * resolution * 4;
                var normalize = function (value, bounds) {
                    return (value - bounds[0]) / (bounds[1] - bounds[0]);
                };
                var reprojectionDatas = [
                    new Uint8Array(size),
                    new Uint8Array(size),
                    new Uint8Array(size)
                ];
                var reprojectionBounds = [-6378137, 6378137];
                var reprojectedPoint = [0, 0, 0];
                // let pixelOffset = 0;
                var byteOffset = 0;
                for (var y = 0; y < resolution; y++) {
                    for (var x = 0; x < resolution; x++) {
                        var pt = [
                            extent.xmin + (x + 0.5) / resolution * extent.width,
                            extent.ymax - (y + 0.5) / resolution * extent.height,
                            0
                        ];
                        externalRenderers.toRenderCoordinates(this.view, pt, 0, extent.spatialReference, reprojectedPoint, 0, 1);
                        this.encodeFloatRGBA(normalize(reprojectedPoint[0], reprojectionBounds), reprojectionDatas[0], byteOffset);
                        this.encodeFloatRGBA(normalize(reprojectedPoint[1], reprojectionBounds), reprojectionDatas[1], byteOffset);
                        this.encodeFloatRGBA(normalize(reprojectedPoint[2], reprojectionBounds), reprojectionDatas[2], byteOffset);
                        // pixelOffset++;
                        byteOffset += 4;
                    }
                }
                return {
                    data: reprojectionDatas,
                    bounds: reprojectionBounds,
                    resolution: resolution
                };
            };
            //以图片设置球背景
            ExternalRenderer.prototype.createTextures = function (context, fetchedRaster) {
                var _this = this;
                // Create:
                //   - velocity field texture, X/Y, velocity in m/s
                //   - 3D re-projection texture
                var rasterData = fetchedRaster.rasterData;
                var resolution = rasterData.width;
                var textureDataSize = resolution * resolution * 4 * 2;
                var reprojectionDatas = this.createReprojectionData(fetchedRaster.extent);
                var gl = context.gl;
                this.velocityField = {
                    texture: this.createTexture(context.gl, resolution, rasterData, gl.NEAREST),
                    offsetU: fetchedRaster.serviceInfo.minValues[0],
                    scaleU: fetchedRaster.serviceInfo.maxValues[0] - fetchedRaster.serviceInfo.minValues[0],
                    offsetV: fetchedRaster.serviceInfo.minValues[1],
                    scaleV: fetchedRaster.serviceInfo.maxValues[1] - fetchedRaster.serviceInfo.minValues[1]
                };
                this.reprojection = {
                    textures: reprojectionDatas.data.map(function (data) { return _this.createTexture(context.gl, reprojectionDatas.resolution, data, gl.LINEAR); }),
                    offset: reprojectionDatas.bounds[0],
                    scale: reprojectionDatas.bounds[1] - reprojectionDatas.bounds[0]
                };
            };
            //创建图片纹理
            ExternalRenderer.prototype.createTexture = function (gl, size, data, interpolation) {
                var texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, interpolation);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, interpolation);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
                if (data instanceof Uint8Array) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
                }
                else {
                    // gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
                }
                return texture;
            };
            ExternalRenderer.prototype.fetchServiceInfo = function (serviceUrl) {
                var options = {
                    query: {
                        f: "json"
                    }
                };
                return request(serviceUrl, options)
                    .then(function (response) { return response.data; });
            };

            ExternalRenderer.prototype.fetchRaster = function () {
                var requestOptions = {
                    responseType: "image",
                    allowImageDataAccess: true
                };
                var serviceInfo = {
                    minValues: [-27.309999465942383, -22.420000076293945],
                    maxValues: [27.65999984741211, 20.969999313354492]
                };
                var extent = new Extent({
                    xmin: -20037508.342788905,
                    xmax: 20037508.342788905,
                    ymin: -20037508.342788905,
                    ymax: 20037508.342788905,
                    spatialReference: 102100
                });
                return request("./data/wind-global.png", requestOptions)
                    .then(function (response) {
                        console.log(response)
                        return {
                            serviceInfo: serviceInfo,
                            extent: extent,
                            rasterData: response.data
                        };
                    });
            };
            return ExternalRenderer;
        }());
        function initialize() {
            view = new SceneView({
                container: "viewDiv",
                map: new Map({
                    basemap: "streets-night-vector"
                }),
                environment: {
                    atmosphere: {
                        quality: "high"
                    }
                },
                constraints: {
                    altitude: {
                        min: 7374827,
                        max: 51025096
                    }
                },
                camera: {
                    position: [-168.491, 23.648, 19175402.86],
                    heading: 360.00,
                    tilt: 1.37
                },
                ui: {
                    components: ["compass"]
                }
            });

            view.when(function () {
                var renderer = new ExternalRenderer(view);
                externalRenderers.add(view, renderer);
            });
            window["view"] = view;
        }
        exports.initialize = initialize;
    });
