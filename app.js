/**
 * Neon Aura AR - Core Application Logic
 * Integrates MediaPipe Hands with HTML5 Canvas Data Visualizations
 */

// --- DOM Elements ---
window.onerror = function(msg) {
    const errorDisplay = document.getElementById('ui-gesture');
    if (errorDisplay) {
        errorDisplay.innerText = 'ERR: ' + msg.substring(0, 30);
        errorDisplay.style.color = '#ff003c';
    }
};
const videoElement = document.querySelector('.input_video');
const bgCanvas = document.getElementById('bgCanvas');
const mainCanvas = document.getElementById('mainCanvas');
const bgCtx = bgCanvas.getContext('2d');
const ctx = mainCanvas.getContext('2d');

const uiHands = document.getElementById('ui-hands');
const uiFps = document.getElementById('ui-fps');
const uiGesture = document.getElementById('ui-gesture');
const uiSpread = document.getElementById('ui-spread');

// --- Global State ---
let width = 1280;
let height = 720;
let time = 0;
let lastTime = performance.now();
let framesThisSecond = 0;
let lastFpsTime = performance.now();

let currentHands = []; 
let handVelocities = 0; 

// --- Air Draw State ---
let isAirDrawMode = false;
let drawingPaths = [];
let currentDrawPaths = [null, null];
let smoothedIndex = { x: 0, y: 0 };
let waveFrames = [];
let lastWipeTime = 0; // Cooldown timer after wipe gesture
let drawActiveFrames = 0; // Sticky draw counter - prevents flicker breaks
const DRAW_STICKY_FRAMES = 20; // ~340ms at 60fps — enough gap to move between cursive letters
let lastRawIndex = { x: 0, y: 0 }; // For light smoothing
let drawOffset = { x: 0, y: 0 }; // Shared with blockOffset for cross-mode consistency

// --- Air Draw Color & Smoothing ---
let airDrawColor = '#39ff14'; // Default neon green; only changed via color wheel
const SMOOTH_WINDOW = 8;      // Rolling-average window size for stroke smoothing
let smoothHistory = [];        // Raw position history for smoothing

// --- Air Draw Pan (two-hand move, mirrors blocks pan) ---
let drawOffset2 = { x: 0, y: 0 }; // Pixel offset applied to all drawing paths
let lastTwoHandMidDraw = null;      // Last midpoint while panning in air-draw mode

// --- Blocks Mode State ---
let isBlocksMode = false;
const BLOCK_SIZE = 40;
const GRID_COLS = 32;
const GRID_ROWS = 18;
let placedBlocks = []; // Array of {col, row}
let blockHover = null; // Current hover position {col, row}
let isBlockPlacing = false;
let blockOffset = { x: 0, y: 0 }; // Pixel offset for moving blocks
let lastTwoHandMid = null; // Last midpoint of two hands for move delta
let pinchStartTime = 0; // When pinch started for loading circle
let blockLoadProgress = 0; // 0-1 progress of loading circle
let blockLoadPos = null; // Screen position for loading circle
let lastPinchCol = -1; // Last grid cell where block was placed
let lastPinchRow = -1;


// --- Theme Config ---
let currentTheme = 'Rainbow';
const themes = {
    'Rainbow':   (t, index, total) => `hsl(${(t * 100 + index * (360/total)) % 360}, 100%, 60%)`,
    'Cyberpunk': (t, index, total) => (index % 2 === 0) ? '#ff003c' : '#00f0ff',
    'Lava':      (t, index, total) => `hsl(${(10 + (index * 10)) % 40}, 100%, ${50 + Math.sin(t)*10}%)`,
    'Ocean':     (t, index, total) => `hsl(${180 + (index * 20)}, 100%, 60%)`,
    'Galaxy':    (t, index, total) => `hsl(${260 + Math.sin(t*2 + index)*40}, 100%, 75%)`
};

// --- Physics Data ---
let particles = [];
let ripples = [];
const FINGER_TIPS = [4, 8, 12, 16, 20];
let lastPinchState = [false, false]; 

// Matrix Background
let matrixColumns = [];
const fontSize = 16;
let maxColumns = 0;

// --- Audio Nodes ---
let audioCtx = null;
let humOsc = null;
let humGain = null;

/**
 * INITIALIZATION
 */
function resize() {
    // Keep canvas internal resolution fixed to match camera feed precisely (1280x720)
    // This prevents tracking offsets when CSS object-fit: cover crops the video!
    bgCanvas.width = 1280;
    bgCanvas.height = 720;
    mainCanvas.width = 1280;
    mainCanvas.height = 720;
    width = 1280;
    height = 720;
    
    maxColumns = Math.floor(1280 / fontSize);
    if (!matrixColumns.length) {
        matrixColumns = new Array(maxColumns).fill(1).map(() => Math.random() * 720/fontSize);
    }
}
window.addEventListener('resize', resize);
resize();

const modeFxBtn = document.getElementById('mode-fx');
const modeDrawBtn = document.getElementById('mode-draw');
const modeBlocksBtn = document.getElementById('mode-blocks');

function setActiveMode(mode) {
    isAirDrawMode = (mode === 'draw');
    isBlocksMode = (mode === 'blocks');
    modeFxBtn.classList.toggle('active', mode === 'fx');
    modeDrawBtn.classList.toggle('active', mode === 'draw');
    if (modeBlocksBtn) modeBlocksBtn.classList.toggle('active', mode === 'blocks');
    currentDrawPaths = [null, null];
}

if (modeFxBtn) modeFxBtn.addEventListener('click', () => setActiveMode('fx'));
if (modeDrawBtn) modeDrawBtn.addEventListener('click', () => setActiveMode('draw'));
if (modeBlocksBtn) modeBlocksBtn.addEventListener('click', () => setActiveMode('blocks'));

const clearDrawBtn = document.getElementById('clearDraw');
if (clearDrawBtn) {
    clearDrawBtn.addEventListener('click', () => {
        drawingPaths = [];
        currentDrawPaths = [null, null];
    });
}

const clearBlocksBtn = document.getElementById('clearBlocks');
if (clearBlocksBtn) {
    clearBlocksBtn.addEventListener('click', () => {
        placedBlocks = [];
        blockOffset = { x: 0, y: 0 };
    });
}

let drawMatrix = true;
const toggleMatrixBtn = document.getElementById('toggleMatrix');
if (toggleMatrixBtn) {
    toggleMatrixBtn.addEventListener('click', (e) => {
        drawMatrix = !drawMatrix;
        if (drawMatrix) {
            e.target.classList.add('active');
            e.target.innerText = 'ON';
        } else {
            e.target.classList.remove('active');
            e.target.innerText = 'OFF';
        }
    });
}

let isAudioMuted = false;
const toggleAudioBtn = document.getElementById('toggleAudio');
if (toggleAudioBtn) {
    toggleAudioBtn.addEventListener('click', (e) => {
        isAudioMuted = !isAudioMuted;
        if (!isAudioMuted) {
            e.target.classList.add('active');
            e.target.innerText = 'ON';
            if (humGain && currentHands.length >= 2) updateHum(currentHands);
        } else {
            e.target.classList.remove('active');
            e.target.innerText = 'OFF';
            if (humGain) humGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
        }
    });
}

// UI Interactivity
document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentTheme = e.target.getAttribute('data-theme');
        // Update the CSS accent based on theme color at index 0
        document.documentElement.style.setProperty('--accent', themes[currentTheme](0, 1, 1));
    });
});

// Cinematic Mode: Press 'H' to hide/show UI for recording
let isCinematic = false;
window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'h') {
        isCinematic = !isCinematic;
        const hud = document.getElementById('hud');
        const themes = document.getElementById('themeContainer');
        if (hud) hud.style.display = isCinematic ? 'none' : 'block';
        if (themes) themes.style.display = isCinematic ? 'none' : 'flex';
        uiGesture.innerText = isCinematic ? "CINEMATIC ON" : "HUD RESTORED";
    }
});

// Start button triggers AudioContext and hides overlay
document.getElementById('startBtn').addEventListener('click', () => {
    document.getElementById('startOverlay').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('themeContainer').classList.remove('hidden');
    initAudio();
    initColorWheel();
    initMediaPipe();
    requestAnimationFrame(renderLoop);
});

/**
 * COLOR WHEEL
 * Appended after the last theme button (Nebula) inside the theme bar.
 * A small swatch button opens a canvas hue-ring + 6 quick swatches.
 * Picking a colour sets airDrawColor and updates the swatch.
 * Picking a theme button (Spectrum…Nebula) still works as before;
 * the colour wheel is an additional "custom colour" option.
 */
function initColorWheel() {
    const WHEEL_R = 72;
    const WHEEL_INNER = 40;
    const SIZE = (WHEEL_R + 8) * 2;

    const themeBar = document.getElementById('themeContainer');

    // ── Divider ────────────────────────────────────────────────────────────
    const divider = document.createElement('div');
    divider.style.cssText = `
        width: 1px; height: 28px;
        background: rgba(255,255,255,0.15);
        align-self: center; margin: 0 4px; flex-shrink: 0;
    `;
    themeBar.appendChild(divider);

    // ── Toggle swatch button ───────────────────────────────────────────────
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'colorWheelToggle';
    toggleBtn.title = 'Custom draw colour';
    toggleBtn.style.cssText = `
        width: 36px; height: 36px; flex-shrink: 0;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.3);
        background: ${airDrawColor};
        box-shadow: 0 0 10px ${airDrawColor};
        cursor: pointer; outline: none;
        transition: transform 0.2s, box-shadow 0.2s;
        position: relative;
    `;
    themeBar.appendChild(toggleBtn);

    // ── Floating wheel popup (above the theme bar, anchored to app-container) ──
    const popup = document.createElement('div');
    popup.style.cssText = `
        position: absolute;
        bottom: 90px;
        left: 50%; transform: translateX(-50%);
        display: none;
        z-index: 30;
    `;

    const wheelCanvas = document.createElement('canvas');
    wheelCanvas.width = SIZE;
    wheelCanvas.height = SIZE;
    wheelCanvas.style.cssText = `
        border-radius: 50%;
        cursor: crosshair;
        box-shadow: 0 6px 30px rgba(0,0,0,0.7);
        display: block;
    `;
    popup.appendChild(wheelCanvas);
    // Append popup to app-container so it doesn't affect theme bar layout
    document.querySelector('.app-container').appendChild(popup);

    // ── Draw hue ring ──────────────────────────────────────────────────────
    const wCtx = wheelCanvas.getContext('2d');
    const cx = SIZE / 2, cy = SIZE / 2;
    for (let i = 0; i < 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        const na = ((i + 1) / 360) * Math.PI * 2;
        wCtx.beginPath();
        wCtx.moveTo(cx, cy);
        wCtx.arc(cx, cy, WHEEL_R, a, na);
        wCtx.closePath();
        wCtx.fillStyle = `hsl(${i},100%,55%)`;
        wCtx.fill();
    }
    // Donut hole
    wCtx.globalCompositeOperation = 'destination-out';
    wCtx.beginPath();
    wCtx.arc(cx, cy, WHEEL_INNER, 0, Math.PI * 2);
    wCtx.fill();
    wCtx.globalCompositeOperation = 'source-over';

    // Inner swatches
    const SWATCHES = ['#39ff14','#ffffff','#ff003c','#00f0ff','#ffcc00','#cc00ff'];
    const swatchR = 11;
    const swatchDist = 22;
    SWATCHES.forEach((col, i) => {
        const a = (i / SWATCHES.length) * Math.PI * 2 - Math.PI / 2;
        const sx = cx + Math.cos(a) * swatchDist;
        const sy = cy + Math.sin(a) * swatchDist;
        wCtx.beginPath();
        wCtx.arc(sx, sy, swatchR, 0, Math.PI * 2);
        wCtx.fillStyle = col;
        wCtx.fill();
        wCtx.strokeStyle = 'rgba(255,255,255,0.45)';
        wCtx.lineWidth = 1.5;
        wCtx.stroke();
    });

    // ── Colour-at-point helper ─────────────────────────────────────────────
    function colourAt(ex, ey) {
        const rect = wheelCanvas.getBoundingClientRect();
        const px = (ex - rect.left) * (SIZE / rect.width);
        const py = (ey - rect.top)  * (SIZE / rect.height);
        const dx = px - cx, dy = py - cy;
        const dist = Math.hypot(dx, dy);
        if (dist >= WHEEL_INNER && dist <= WHEEL_R) {
            const hue = ((Math.atan2(dy, dx) / (Math.PI * 2)) * 360 + 360) % 360;
            return `hsl(${Math.round(hue)},100%,55%)`;
        }
        for (let i = 0; i < SWATCHES.length; i++) {
            const a = (i / SWATCHES.length) * Math.PI * 2 - Math.PI / 2;
            const sx = cx + Math.cos(a) * swatchDist;
            const sy = cy + Math.sin(a) * swatchDist;
            if (Math.hypot(px - sx, py - sy) <= swatchR) return SWATCHES[i];
        }
        return null;
    }

    function applyColour(col) {
        if (!col) return;
        airDrawColor = col;
        toggleBtn.style.background = col;
        toggleBtn.style.boxShadow = `0 0 12px ${col}`;
        popup.style.display = 'none';
        wheelOpen = false;
        // Deactivate theme buttons visually so user knows custom colour is active
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        toggleBtn.style.border = '2px solid rgba(255,255,255,0.7)';
    }

    let wheelOpen = false;
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        wheelOpen = !wheelOpen;
        popup.style.display = wheelOpen ? 'block' : 'none';
        toggleBtn.style.transform = wheelOpen ? 'scale(1.2)' : 'scale(1)';
    });

    wheelCanvas.addEventListener('click', (e) => {
        applyColour(colourAt(e.clientX, e.clientY));
    });

    // Close wheel if user clicks a theme button
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            popup.style.display = 'none';
            wheelOpen = false;
            toggleBtn.style.border = '2px solid rgba(255,255,255,0.3)';
        });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!popup.contains(e.target) && e.target !== toggleBtn) {
            popup.style.display = 'none';
            wheelOpen = false;
        }
    });
}

/**
 * AUDIO ENGINE
 */
function initAudio() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        
        humOsc = audioCtx.createOscillator();
        humGain = audioCtx.createGain();
        
        humOsc.type = 'sine';
        humOsc.frequency.value = 80;
        
        humGain.gain.value = 0; // Mute until hands are seen
        
        humOsc.connect(humGain);
        humGain.connect(audioCtx.destination);
        humOsc.start();
    } catch(e) {
        console.error("Web Audio API not supported", e);
    }
}

function triggerZap() {
    if (!audioCtx || isAudioMuted) return;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, audioCtx.currentTime + 0.1);
    
    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
}

function updateHum(activeHands) {
    if (!audioCtx || !humGain) return;
    if (activeHands.length < 2 || isAudioMuted) {
        humGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
        return;
    }

    // Proximity mapping between index fingers
    const p1 = activeHands[0][8];
    const p2 = activeHands[1][8];
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    const targetFreq = 80 + (1 - Math.min(dist, 1)) * 200;
    const targetVolume = 0.02 + (1 - Math.min(dist, 1)) * 0.08;
    
    humOsc.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.1);
    humGain.gain.setTargetAtTime(targetVolume, audioCtx.currentTime, 0.1);
}

/**
 * MATH & LOGIC
 */
function getDist(p1, p2) {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function mapToCanvas(point) {
    return { x: point.x * width, y: point.y * height };
}

function getVisualPoint(point) {
    return { x: width - (point.x * width), y: point.y * height };
}

function detectGestures() {
    if (!currentHands.length) return;
    
    currentHands.forEach((hand, idx) => {
        const thumb = hand[4];
        const index = hand[8];
        const middle = hand[12];
        const wrist = hand[0];
        
        const dist = getDist(thumb, index);
        const isPinching = dist < 0.06; 
        
        const indexLen = getDist(hand[8], hand[0]);
        const indexKnuckle = getDist(hand[5], hand[0]);
        const middleLen = getDist(hand[12], hand[0]);
        const middleKnuckle = getDist(hand[9], hand[0]);
        const ringLen = getDist(hand[16], hand[0]);
        const ringKnuckle = getDist(hand[13], hand[0]);
        const pinkyLen = getDist(hand[20], hand[0]);
        const pinkyKnuckle = getDist(hand[17], hand[0]);

        const isPointing = (indexLen > indexKnuckle * 1.5) && (middleLen < middleKnuckle * 1.2) && (ringLen < ringKnuckle * 1.2);
        const isOpenPalm = (indexLen > indexKnuckle * 1.2 && middleLen > middleKnuckle * 1.2 && ringLen > ringKnuckle * 1.2 && pinkyLen > pinkyKnuckle * 1.2);

        const midRaw = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
        const allowDraw = (idx === 0);

        if (isAirDrawMode) {
            // Two-hand pan: move all drawn strokes together (handled outside per-hand loop below)
            // Single-hand logic only runs when exactly one hand is present
            if (allowDraw && currentHands.length === 1) {
                // Swipe-to-clear
                if (waveFrames.length > 0) {
                    const lastW = waveFrames[waveFrames.length - 1];
                    if (Math.abs(wrist.x - lastW.x) > 0.20 && (time - lastW.time) < 0.1) waveFrames = [];
                }
                waveFrames.push({x: wrist.x, time: time});
                if (waveFrames.length > 15) waveFrames.shift();
                for (let i = 0; i < waveFrames.length - 1; i++) {
                    let dx = Math.abs(waveFrames[i].x - wrist.x);
                    let dt = time - waveFrames[i].time;
                    if (dx > 0.30 && dt < 0.6) {
                        drawingPaths = [];
                        currentDrawPaths[0] = null;
                        smoothHistory = [];
                        uiGesture.innerText = "WIPE CLEAR!";
                        uiGesture.style.color = '#ff003c';
                        waveFrames = [];
                        lastWipeTime = time;
                        break;
                    }
                }
            }

            if (isPointing && allowDraw && (time - lastWipeTime > 2.5)) {
                // Rolling-window average for smoothing
                smoothHistory.push({ x: index.x, y: index.y });
                if (smoothHistory.length > SMOOTH_WINDOW) smoothHistory.shift();
                const avgX = smoothHistory.reduce((s, p) => s + p.x, 0) / smoothHistory.length;
                const avgY = smoothHistory.reduce((s, p) => s + p.y, 0) / smoothHistory.length;

                // Secondary EMA pass for extra silkiness
                // On the very first point of a new stroke, snap directly to position (no lerp jump)
                if (!currentDrawPaths[idx]) lastRawIndex = { x: avgX, y: avgY };
                lastRawIndex.x = lastRawIndex.x * 0.55 + avgX * 0.45;
                lastRawIndex.y = lastRawIndex.y * 0.55 + avgY * 0.45;

                const canvasPt = {
                    x: lastRawIndex.x * width,
                    y: lastRawIndex.y * height
                };

                drawActiveFrames = DRAW_STICKY_FRAMES; // reset sticky counter on active draw

                if (currentDrawPaths[idx]) {
                    const pts = currentDrawPaths[idx].points;
                    const last = pts[pts.length - 1];
                    if (Math.hypot(canvasPt.x - last.x, canvasPt.y - last.y) > 2.5) {
                        pts.push(canvasPt);
                    }
                } else {
                    currentDrawPaths[idx] = {
                        color: airDrawColor, // fixed colour — never changes on lift
                        points: [canvasPt]
                    };
                    drawingPaths.push(currentDrawPaths[idx]);
                    uiGesture.innerText = "AIR DRAW";
                }
            } else if (allowDraw) {
                // Sticky frames: keep stroke alive briefly to prevent mid-stroke breaks
                if (drawActiveFrames > 0) {
                    drawActiveFrames--;
                } else {
                    smoothHistory = [];
                    // Do NOT reset lastRawIndex — preserving last position means the
                    // next stroke starts exactly where the last one ended, so cursive
                    // letters connect instead of jumping to a new position.
                    if (currentDrawPaths[idx]) {
                        currentDrawPaths[idx] = null;
                    }
                }
            }
        }

        if (isBlocksMode && currentHands.length < 2) {
            // Swipe-to-clear: ONLY if one hand is present to avoid accidental wipe while moving
            if (allowDraw) {
                if (waveFrames.length > 0) {
                    const lastW = waveFrames[waveFrames.length - 1];
                    if (Math.abs(wrist.x - lastW.x) > 0.20 && (time - lastW.time) < 0.1) waveFrames = [];
                }
                waveFrames.push({x: wrist.x, time: time});
                if (waveFrames.length > 15) waveFrames.shift();
                for (let i = 0; i < waveFrames.length - 1; i++) {
                    if (Math.abs(waveFrames[i].x - wrist.x) > 0.30 && (time - waveFrames[i].time) < 0.6) {
                        placedBlocks = [];
                        blockOffset = { x: 0, y: 0 };
                        uiGesture.innerText = "CLEARED";
                        waveFrames = [];
                        lastWipeTime = time;
                        break;
                    }
                }
            }
            
            // PRIMARY HAND (idx = 0) = PLACE/ERASE
            if (allowDraw && (time - lastWipeTime > 2.5)) {
                if (!lastRawIndex.x) lastRawIndex = { x: index.x, y: index.y };
                lastRawIndex.x = lastRawIndex.x * 0.4 + index.x * 0.6;
                lastRawIndex.y = lastRawIndex.y * 0.4 + index.y * 0.6;
                
                const canvasPt = mapToCanvas(lastRawIndex);
                const col = Math.floor((canvasPt.x - blockOffset.x) / BLOCK_SIZE);
                const row = Math.floor((canvasPt.y - blockOffset.y) / BLOCK_SIZE);
                
                if (col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS) {
                    blockHover = { col, row };
                    blockLoadPos = canvasPt;
                    
                    if (isOpenPalm) {
                        const exists = placedBlocks.findIndex(b => b.col === col && b.row === row);
                        if (exists !== -1) {
                            placedBlocks.splice(exists, 1);
                            uiGesture.innerText = "ERASING";
                            uiGesture.style.color = '#ff003c';
                        }
                        pinchStartTime = 0;
                        blockLoadProgress = 0;
                    } else if (isPinching) {
                        if (pinchStartTime === 0) {
                            pinchStartTime = time;
                            lastPinchCol = -1;
                            lastPinchRow = -1;
                        }
                        
                        blockLoadProgress = Math.min((time - pinchStartTime) / 0.5, 1.0);
                        
                        if (blockLoadProgress >= 1.0 && (col !== lastPinchCol || row !== lastPinchRow)) {
                            const exists = placedBlocks.findIndex(b => b.col === col && b.row === row);
                            if (exists === -1) {
                                placedBlocks.push({ col, row, t: time });
                            }
                            lastPinchCol = col;
                            lastPinchRow = row;
                            pinchStartTime = time; 
                            uiGesture.innerText = "PLACED";
                            uiGesture.style.color = '#00ff88';
                        } else {
                            uiGesture.innerText = `CHARGING ${Math.round(blockLoadProgress * 100)}%`;
                            uiGesture.style.color = '#ffcc00';
                        }
                    } else {
                        pinchStartTime = 0;
                        blockLoadProgress = 0;
                        lastPinchCol = -1;
                        lastPinchRow = -1;
                    }
                } else {
                    blockHover = null;
                    blockLoadProgress = 0;
                }
            }
        }
    }); // End per-hand loop

    // --- SHARED WORLD PANNING ---
    if (currentHands.length >= 2) {
        const h1 = currentHands[0];
        const h2 = currentHands[1];
        const mid = {
            x: ((h1[4].x + h1[8].x)/2 + (h2[4].x + h2[8].x)/2) / 2,
            y: ((h1[4].y + h1[8].y)/2 + (h2[4].y + h2[8].y)/2) / 2
        };

        if (isBlocksMode) {
            if (lastTwoHandMid) {
                blockOffset.x += (mid.x - lastTwoHandMid.x) * width;
                blockOffset.y += (mid.y - lastTwoHandMid.y) * height;
            }
            lastTwoHandMid = mid;

            uiGesture.innerText = "MOVING";
            uiGesture.style.color = '#00f0ff';

            pinchStartTime = 0;
            blockLoadProgress = 0;
            blockHover = null;
        } else {
            lastTwoHandMid = null;
        }

        if (isAirDrawMode) {
            if (lastTwoHandMidDraw) {
                const dx = (mid.x - lastTwoHandMidDraw.x) * width;
                const dy = (mid.y - lastTwoHandMidDraw.y) * height;
                // Shift every point in every existing path
                drawingPaths.forEach(path => {
                    path.points.forEach(pt => {
                        pt.x += dx;
                        pt.y += dy;
                    });
                });
            }
            lastTwoHandMidDraw = mid;

            uiGesture.innerText = "MOVING";
            uiGesture.style.color = '#00f0ff';

            // End any active stroke so pan doesn't draw
            currentDrawPaths = [null, null];
            smoothHistory = [];
        } else {
            lastTwoHandMidDraw = null;
        }
    } else {
        lastTwoHandMid = null;
        lastTwoHandMidDraw = null;
    }

    if (currentHands[0]) {
        const spread = getDist(currentHands[0][8], currentHands[0][20]);
        let pct = Math.min(Math.round(spread * 350), 100);
        if (uiSpread) uiSpread.innerText = pct + '%';
    }
}

/**
 * GRAPHICS
 */
function createParticles(pos, color, count = 3) {
    for (let i=0; i<count; i++) {
        particles.push({
            x: pos.x, y: pos.y,
            vx: (Math.random() - 0.5) * 6,
            vy: (Math.random() - 0.5) * 6,
            life: 1.0, color: color,
            size: Math.random() * 2 + 1
        });
    }
}

function createShockwave(pos, color) {
    ripples.push({
        x: pos.x, y: pos.y,
        radius: 0, maxRadius: 100 + Math.random() * 80,
        life: 1.0, color: color
    });
}

function drawBackground() {
    bgCtx.globalCompositeOperation = 'destination-out';
    bgCtx.fillStyle = `rgba(0, 0, 0, ${0.1 + Math.min(handVelocities*8, 0.4)})`;
    bgCtx.fillRect(0, 0, width, height);
    bgCtx.globalCompositeOperation = 'source-over';

    if (!drawMatrix) return;

    bgCtx.fillStyle = themes[currentTheme](time, 1, 1);
    bgCtx.font = fontSize + "px monospace";
    
    let speedMult = 1 + (handVelocities * 80);

    for (let i = 0; i < matrixColumns.length; i++) {
        if (Math.random() > 0.95) {
            const char = String.fromCharCode(0x30A0 + Math.random() * 96);
            bgCtx.fillText(char, i * fontSize, matrixColumns[i] * fontSize);
        }
        matrixColumns[i] += Math.random() * speedMult;
        if (matrixColumns[i] * fontSize > height && Math.random() > 0.9) {
            matrixColumns[i] = 0;
        }
    }
}

function updatePhysics() {
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.life -= 0.03; p.vy += 0.05; // slight gravity
        if (p.life <= 0) { particles.splice(i, 1); }
        else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = p.life;
            ctx.fill();
        }
    }
    
    for (let i = ripples.length - 1; i >= 0; i--) {
        let r = ripples[i];
        r.radius += (r.maxRadius - r.radius) * 0.15;
        r.life -= 0.04;
        if (r.life <= 0) { ripples.splice(i, 1); } 
        else {
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
            ctx.strokeStyle = r.color;
            ctx.lineWidth = 3 * r.life;
            ctx.globalAlpha = r.life;
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1.0;
}


/**
 * BLOCKS RENDERING
 */
function drawBlocks() {
    const BS = BLOCK_SIZE;
    const DEPTH = 12; // 3D extrusion depth
    
    ctx.save();
    ctx.translate(blockOffset.x, blockOffset.y);
    
    // Build a fast lookup set for adjacency checks
    const blockSet = new Set();
    placedBlocks.forEach(b => blockSet.add(`${b.col},${b.row}`));
    
    function hasBlock(c, r) { return blockSet.has(`${c},${r}`); }
    
    // Draw hover preview (isometric wireframe guide)
    if (blockHover) {
        ctx.save();
        const hx = blockHover.col * BS;
        const hy = blockHover.row * BS;
        
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4 + Math.sin(time * 8) * 0.2; // Pulsing opacity
        
        // Draw standard blue wireframe, turns red if hovering an existing block (erase preview)
        const isHoveringExisting = hasBlock(blockHover.col, blockHover.row);
        ctx.strokeStyle = isHoveringExisting ? '#ff003c' : '#00f0ff';
        
        // Front face
        ctx.strokeRect(hx, hy, BS, BS);
        
        // 3D wireframe connecting lines to back face
        ctx.beginPath();
        ctx.moveTo(hx, hy);                 ctx.lineTo(hx + DEPTH, hy + DEPTH);
        ctx.moveTo(hx + BS, hy);            ctx.lineTo(hx + BS + DEPTH, hy + DEPTH);
        ctx.moveTo(hx, hy + BS);            ctx.lineTo(hx + DEPTH, hy + BS + DEPTH);
        ctx.moveTo(hx + BS, hy + BS);       ctx.lineTo(hx + BS + DEPTH, hy + BS + DEPTH);
        ctx.stroke();
        
        // Back face wireframe
        ctx.strokeRect(hx + DEPTH, hy + DEPTH, BS, BS);
        
        if (isHoveringExisting) {
            ctx.fillStyle = 'rgba(255, 0, 60, 0.4)';
            ctx.fillRect(hx, hy, BS, BS);
        } else {
            ctx.fillStyle = 'rgba(0, 240, 255, 0.2)';
            ctx.fillRect(hx, hy, BS, BS);
        }
        
        ctx.restore();
    }
    
    // --- PASS 1: Draw 3D extrusion faces (bottom and right depth) ---
    placedBlocks.forEach(block => {
        const bx = block.col * BS;
        const by = block.row * BS;
        
        // Bottom extrusion (only if no block below)
        if (!hasBlock(block.col, block.row + 1)) {
            ctx.fillStyle = '#555';
            ctx.beginPath();
            ctx.moveTo(bx, by + BS);
            ctx.lineTo(bx + BS, by + BS);
            ctx.lineTo(bx + BS + DEPTH, by + BS + DEPTH);
            ctx.lineTo(bx + DEPTH, by + BS + DEPTH);
            ctx.closePath();
            ctx.fill();
        }
        
        // Right extrusion (only if no block to the right)
        if (!hasBlock(block.col + 1, block.row)) {
            ctx.fillStyle = '#888';
            ctx.beginPath();
            ctx.moveTo(bx + BS, by);
            ctx.lineTo(bx + BS + DEPTH, by + DEPTH);
            ctx.lineTo(bx + BS + DEPTH, by + BS + DEPTH);
            ctx.lineTo(bx + BS, by + BS);
            ctx.closePath();
            ctx.fill();
        }
        
        // Corner piece (only if no block right AND no block below)
        if (!hasBlock(block.col + 1, block.row) && !hasBlock(block.col, block.row + 1)) {
            ctx.fillStyle = '#666';
            ctx.beginPath();
            ctx.moveTo(bx + BS, by + BS);
            ctx.lineTo(bx + BS + DEPTH, by + BS + DEPTH);
            ctx.closePath();
        }
    });
    
    // --- PASS 2: Draw top faces (solid connected surface) ---
    placedBlocks.forEach(block => {
        const bx = block.col * BS;
        const by = block.row * BS;
        
        ctx.fillStyle = '#D8D8D8';
        ctx.fillRect(bx, by, BS, BS);
    });
    
    // --- PASS 3: Draw only OUTER edges (not between adjacent blocks) ---
    ctx.strokeStyle = 'rgba(80,80,80,0.6)';
    ctx.lineWidth = 1;
    
    placedBlocks.forEach(block => {
        const bx = block.col * BS;
        const by = block.row * BS;
        
        // Top edge (only if no block above)
        if (!hasBlock(block.col, block.row - 1)) {
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + BS, by);
            ctx.stroke();
        }
        // Bottom edge (only if no block below)
        if (!hasBlock(block.col, block.row + 1)) {
            ctx.beginPath();
            ctx.moveTo(bx, by + BS);
            ctx.lineTo(bx + BS, by + BS);
            ctx.stroke();
        }
        // Left edge (only if no block to the left)
        if (!hasBlock(block.col - 1, block.row)) {
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx, by + BS);
            ctx.stroke();
        }
        // Right edge (only if no block to the right)
        if (!hasBlock(block.col + 1, block.row)) {
            ctx.beginPath();
            ctx.moveTo(bx + BS, by);
            ctx.lineTo(bx + BS, by + BS);
            ctx.stroke();
        }
    });
    ctx.restore();
    
    // Draw loading circle (not affected by blockOffset)
    if (blockLoadProgress > 0 && blockLoadPos) {
        const cx = blockLoadPos.x;
        const cy = blockLoadPos.y;
        const radius = 22;
        
        // Background circle (dim)
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        // Progress arc
        ctx.beginPath();
        ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + blockLoadProgress * Math.PI * 2);
        ctx.strokeStyle = blockLoadProgress >= 1.0 ? '#00ff88' : '#ffcc00';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        // Flash when complete
        if (blockLoadProgress >= 1.0) {
            ctx.beginPath();
            ctx.arc(cx, cy, radius + 5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,255,136,0.4)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }
}

/**
 * MAIN LOOP
 */
function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);
    
    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    time += dt;

    framesThisSecond++;
    if (timestamp > lastFpsTime + 1000) {
        uiFps.innerText = framesThisSecond;
        framesThisSecond = 0;
        lastFpsTime = timestamp;
    }

    drawBackground();

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'screen';
    updatePhysics();

    // Render blocks if in blocks mode
    if (isBlocksMode) {
        ctx.globalCompositeOperation = 'source-over';
        drawBlocks();
        ctx.globalCompositeOperation = 'screen';
    }

    if (drawingPaths.length > 0) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        
        drawingPaths.forEach(path => {
            if (path.points.length < 2) return;
            ctx.beginPath();
            ctx.moveTo(path.points[0].x, path.points[0].y);
            
            for (let i = 1; i < path.points.length - 2; i++) {
                const xc = (path.points[i].x + path.points[i+1].x) / 2;
                const yc = (path.points[i].y + path.points[i+1].y) / 2;
                ctx.quadraticCurveTo(path.points[i].x, path.points[i].y, xc, yc);
            }
            if (path.points.length > 2) {
                const p1 = path.points[path.points.length-2];
                const p2 = path.points[path.points.length-1];
                ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
            } else {
                ctx.lineTo(path.points[1].x, path.points[1].y);
            }
            ctx.strokeStyle = path.color;
            ctx.lineWidth = 12;
            ctx.shadowBlur = 15;
            ctx.shadowColor = path.color;
            ctx.stroke();
            
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#fff';
            ctx.shadowBlur = 0;
            ctx.stroke();
        });
        ctx.restore();
    }

    if (currentHands.length > 0) {
        currentHands.forEach((hand, handIndex) => {
            const glowColor = themes[currentTheme](time, handIndex, 2);
            
            // Draw skeleton lines
            drawConnectors(ctx, hand, HAND_CONNECTIONS, {
                color: glowColor, lineWidth: 2
            });
            
            // Draw landmarks and spawn particles
            ctx.shadowBlur = 20;
            ctx.shadowColor = glowColor;
            
            FINGER_TIPS.forEach((tipIndex, idx) => {
                const pt = mapToCanvas(hand[tipIndex]);
                const tipCol = themes[currentTheme](time, idx, FINGER_TIPS.length);
                
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();

                if (Math.random() > 0.6) {
                    createParticles(pt, tipCol, 1);
                }
            });
            ctx.shadowBlur = 0;
        });

        // Cross-hand logic
        if (currentHands.length >= 2) {
            const h1 = currentHands[0];
            const h2 = currentHands[1];

            FINGER_TIPS.forEach((tipIndex, idx) => {
                const pt1 = mapToCanvas(h1[tipIndex]);
                const pt2 = mapToCanvas(h2[tipIndex]);
                const dist = getDist(pt1, pt2);
                const col = themes[currentTheme](time, idx, FINGER_TIPS.length);
                
                if (dist < 180 && Math.random() > 0.5) {
                    ctx.beginPath();
                    ctx.moveTo(pt1.x, pt1.y);
                    const midX = (pt1.x + pt2.x)/2 + (Math.random() - 0.5) * 40;
                    const midY = (pt1.y + pt2.y)/2 + (Math.random() - 0.5) * 40;
                    ctx.lineTo(midX, midY);
                    ctx.lineTo(pt2.x, pt2.y);
                    
                    ctx.strokeStyle = '#fff';
                    ctx.shadowBlur = 15;
                    ctx.shadowColor = col;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }

                ctx.beginPath();
                ctx.moveTo(pt1.x, pt1.y);
                ctx.lineTo(pt2.x, pt2.y);
                
                let grad = ctx.createLinearGradient(pt1.x, pt1.y, pt2.x, pt2.y);
                grad.addColorStop(0, themes[currentTheme](time, idx, 5));
                grad.addColorStop(1, themes[currentTheme](time, idx + 2, 5));
                
                ctx.strokeStyle = grad;
                ctx.lineWidth = 3;
                ctx.stroke();
            });
        }
        detectGestures();
    }
    
    ctx.globalCompositeOperation = 'source-over';
}

/**
 * MEDIAPIPE INITIALIZATION
 */
function initMediaPipe() {
    const hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});

    hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1, 
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    hands.onResults((results) => {
        if (!audioCtx) return;

        uiHands.innerText = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;
        
        if (currentHands.length > 0 && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            let vSum = 0;
            const oldP = currentHands[0][8];
            const newP = results.multiHandLandmarks[0][8];
            if (oldP && newP) {
                vSum += getDist(oldP, newP);
                handVelocities = vSum; 
            }
        } else {
            handVelocities = 0;
        }

        currentHands = results.multiHandLandmarks || [];
        updateHum(currentHands);
    });

    const camera = new Camera(videoElement, {
        onFrame: async () => {
            await hands.send({image: videoElement});
        },
        width: 1280,
        height: 720,
        facingMode: 'user'
    });
    
    camera.start();
}
