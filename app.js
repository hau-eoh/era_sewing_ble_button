// State Management
const state = {
    nodes: {},               // Keyed by node_id
    totalNodes: 1000,        // Default simulated nodes (user can adjust up to 10,000)
    filteredNodeIds: [],     // Sorted and filtered list of IDs
    currentPage: 1,
    itemsPerPage: 24,
    connectionStatus: 'simulating', // 'connecting', 'active', 'simulating'
    demoMode: true,          // Loaded from localStorage or URL parameter
    selectedNodeId: null,
    searchQuery: '',
    statusFilter: 'all',
    batteryFilter: 'all',
    groupFilter: 'all',      // Group (Tổ) filter
    processFilter: 'all',    // Process (Công đoạn) filter
    sortBy: 'id_asc',
    gridColorMode: 'status', // 'status', 'group', 'process'
    pressRate: 5,            // Simulated presses per second
    offlineRate: 5,          // Percentage of simulated offline nodes
    heartbeatTimeout: 300    // Heartbeat timeout in seconds (default 5 minutes)
};

// Colors for Groups & Processes
const COLORS = {
    groups: {
        'Tổ 1': '#06b6d4', // Cyan
        'Tổ 2': '#3b82f6', // Blue
        'Tổ 3': '#a855f7', // Purple
        'Tổ 4': '#f97316', // Orange
        'Tổ 5': '#ec4899'  // Pink
    },
    processes: {
        'May Cổ': '#10b981',  // Emerald
        'Ráp Thân': '#f59e0b', // Amber
        'Tra Khóa': '#e11d48',  // Rose
        'Lên Gấu': '#2563eb',  // Blue
        'Vắt Sổ': '#0891b2'   // Cyan
    }
};

// Simulation Interval Hooks
let simPressInterval = null;
let simOfflineCheckInterval = null;
let watchdogInterval = null;
let uiUpdateScheduled = false;

// Chart Instances
let statusChartInstance = null;
let batteryChartInstance = null;
let groupProductionChartInstance = null;
let topProductionChartInstance = null;

// DOM Elements
const nodesContainer = document.getElementById('nodesContainer');
const paginationControls = document.getElementById('paginationControls');
const paginationInfo = document.getElementById('paginationInfo');
const statTotalNodes = document.getElementById('statTotalNodes');
const statOnlineNodes = document.getElementById('statOnlineNodes');
const statOfflineNodes = document.getElementById('statOfflineNodes');
const statLowBattery = document.getElementById('statLowBattery');
const statNormalBattery = document.getElementById('statNormalBattery');
const statTotalPressCount = document.getElementById('statTotalPressCount');
const eraStatusDot = document.getElementById('eraStatusDot');
const eraStatusText = document.getElementById('eraStatusText');
const factoryCanvas = document.getElementById('factoryCanvas');
const gridTooltip = document.getElementById('gridTooltip');
const gridLegend = document.getElementById('gridLegend');
const demoModeToggle = document.getElementById('demoModeToggle');

// E-Ra Widget SDK Initialization
const eraWidget = new EraWidget();

// Initialize application
window.addEventListener('DOMContentLoaded', () => {
    // Load Demo Mode state from localStorage
    const savedDemoMode = localStorage.getItem('era_demo_mode');
    if (savedDemoMode !== null) {
        state.demoMode = savedDemoMode === 'true';
    }
    
    // Sync UI checkbox
    if (demoModeToggle) {
        demoModeToggle.checked = state.demoMode;
    }
    
    // Start Lucide icons
    lucide.createIcons();
    
    // Set up Simulator Defaults
    updateSimCountLabel();
    updateSimPressLabel();
    updateSimOfflineLabel();
    
    // Create initial database based on mode
    if (state.demoMode) {
        state.connectionStatus = 'simulating';
        updateConnectionStatus('simulating', 'Chạy Giả Lập');
        reseedSimulator();
        startSimulationLoops();
    } else {
        state.connectionStatus = 'connecting';
        updateConnectionStatus('connecting', 'Chờ tín hiệu E-Ra...');
        state.nodes = {};
        state.totalNodes = 0;
    }
    
    // Initialize E-Ra Widget (runs in background to listen)
    initializeEraWidget();
    
    // Canvas Listeners
    setupCanvasListeners();
    
    // First UI Render
    requestUpdateUI();
    
    // Draw initial charts
    initCharts();
    
    // Start Watchdog heartbeat check
    startWatchdog();
});

/* ==========================================================================
   E-Ra WIDGET SDK INTEGRATION
   ========================================================================== */
function initializeEraWidget() {
    try {
        eraWidget.init({
            needRealtimeConfigs: true,
            needHistoryConfigs: false,
            needActions: false,
            onConfiguration: (configuration) => {
                console.log('E-Ra Configuration Received:', configuration);
                // If demo mode is OFF, mark connected
                if (!state.demoMode) {
                    updateConnectionStatus('active', 'E-Ra Connected');
                }
            },
            onValues: (values) => {
                console.log('E-Ra Values Received:', values);
                
                // If E-Ra starts receiving values, and demo mode is OFF, make it active
                if (!state.demoMode) {
                    state.connectionStatus = 'active';
                    updateConnectionStatus('active', 'E-Ra Live');
                }
                
                // Ingest values regardless, but we only apply to active UI map if not in demoMode
                let updated = false;
                for (const pinId in values) {
                    const rawVal = values[pinId]?.value;
                    if (!rawVal) continue;
                    
                    try {
                        const data = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
                        
                        if (data && data.node_id !== undefined) {
                            const nodeId = parseInt(data.node_id, 10);
                            
                            // Normalizing Battery Voltage (e.g. 380 -> 3.80V)
                            const rawMv = parseInt(data.battery_mv, 10);
                            let batteryPct = parseInt(data.battery_pct, 10) || 0;
                            
                            if (batteryPct === 0 && rawMv) {
                                const volts = rawMv > 1000 ? rawMv / 1000 : (rawMv > 100 ? rawMv / 100 : rawMv);
                                batteryPct = Math.max(0, Math.min(100, Math.round(((volts - 2.8) / (4.2 - 2.8)) * 100)));
                            }
                            
                            // Deterministic Group and Process if not provided in payload
                            const group = data.group || `Tổ ${((nodeId - 1) % 5) + 1}`;
                            const process = data.process || ['May Cổ', 'Ráp Thân', 'Tra Khóa', 'Lên Gấu', 'Vắt Sổ'][(nodeId - 1) % 5];
                            
                            const nodeData = {
                                node_id: nodeId,
                                event: data.event || 'press',
                                press_count: parseInt(data.press_count, 10) || 0,
                                battery_mv: rawMv,
                                battery_pct: batteryPct,
                                rssi: parseInt(data.rssi, 10) || -60,
                                group: group,
                                process: process,
                                online: data.online !== undefined ? (data.online === true || data.online === 'true') : true,
                                last_seen_epoch: parseInt(data.last_seen_epoch, 10) || Math.floor(Date.now() / 1000),
                                gateway_uptime_ms: parseInt(data.gateway_uptime_ms, 10) || 0
                            };
                            
                            // Only update UI node state if demo mode is off
                            if (!state.demoMode) {
                                state.nodes[nodeId] = nodeData;
                                // Expand totalNodes if we receive larger node IDs
                                if (nodeId > state.totalNodes) {
                                    state.totalNodes = nodeId;
                                }
                                updated = true;
                            }
                        }
                    } catch (err) {
                        console.warn('Không thể parse dữ liệu JSON từ E-Ra Pin:', pinId, rawVal, err);
                    }
                }
                
                if (updated && !state.demoMode) {
                    requestUpdateUI();
                }
            }
        });
    } catch (e) {
        console.error('Lỗi khi init E-Ra SDK:', e);
    }
}

function updateConnectionStatus(status, text) {
    state.connectionStatus = status;
    eraStatusDot.className = 'status-dot';
    
    if (status === 'active') {
        eraStatusDot.classList.add('active');
        eraStatusText.textContent = text;
    } else if (status === 'simulating') {
        eraStatusDot.classList.add('simulating');
        eraStatusText.textContent = text;
    } else {
        eraStatusText.textContent = text;
    }
}

function toggleDemoMode() {
    const checkbox = document.getElementById('demoModeToggle');
    state.demoMode = checkbox.checked;
    localStorage.setItem('era_demo_mode', state.demoMode);
    
    if (state.demoMode) {
        updateConnectionStatus('simulating', 'Chạy Giả Lập');
        const countSlider = document.getElementById('simNodeCount');
        state.totalNodes = parseInt(countSlider.value, 10);
        reseedSimulator();
        startSimulationLoops();
    } else {
        updateConnectionStatus('connecting', 'Chờ tín hiệu E-Ra...');
        state.nodes = {};
        state.totalNodes = 0;
        if (simPressInterval) clearInterval(simPressInterval);
        if (simOfflineCheckInterval) clearInterval(simOfflineCheckInterval);
    }
    state.currentPage = 1;
    requestUpdateUI();
}

/* ==========================================================================
   SIMULATOR MOTOR ENGINE
   ========================================================================== */
function reseedSimulator() {
    state.nodes = {};
    const nowEpoch = Math.floor(Date.now() / 1000);
    
    const groups = ['Tổ 1', 'Tổ 2', 'Tổ 3', 'Tổ 4', 'Tổ 5'];
    const processes = ['May Cổ', 'Ráp Thân', 'Tra Khóa', 'Lên Gấu', 'Vắt Sổ'];
    
    for (let id = 1; id <= state.totalNodes; id++) {
        const initialPressCount = Math.floor(Math.random() * 300) + 10;
        const volts = 3.2 + Math.random() * 0.9;
        const batteryMv = Math.round(volts * 100);
        const batteryPct = Math.round(((volts - 3.0) / (4.2 - 3.0)) * 100);
        
        const isOffline = (Math.random() * 100) < state.offlineRate;
        const rssi = -45 - Math.floor(Math.random() * 45);
        const uptime = Math.floor(Math.random() * 1000000) + 30000;
        
        // Group and Process assignments
        const group = groups[(id - 1) % groups.length];
        const process = processes[(id - 1) % processes.length];
        
        state.nodes[id] = {
            node_id: id,
            event: 'press',
            press_count: initialPressCount,
            battery_mv: batteryMv,
            battery_pct: Math.max(0, Math.min(100, batteryPct)),
            rssi: rssi,
            group: group,
            process: process,
            online: !isOffline,
            last_seen_epoch: nowEpoch - Math.floor(Math.random() * (isOffline ? 86400 : 300)),
            gateway_uptime_ms: uptime
        };
    }
    requestUpdateUI();
}

function startSimulationLoops() {
    if (simPressInterval) clearInterval(simPressInterval);
    if (simOfflineCheckInterval) clearInterval(simOfflineCheckInterval);
    
    const delay = 1000 / state.pressRate;
    simPressInterval = setInterval(() => {
        if (!state.demoMode) return;
        
        const onlineNodeIds = Object.keys(state.nodes).filter(id => state.nodes[id].online);
        if (onlineNodeIds.length === 0) return;
        
        const randomId = onlineNodeIds[Math.floor(Math.random() * onlineNodeIds.length)];
        const node = state.nodes[randomId];
        
        node.press_count += 1;
        node.last_seen_epoch = Math.floor(Date.now() / 1000);
        node.event = 'press';
        node.gateway_uptime_ms += Math.round(delay);
        
        if (Math.random() < 0.1 && node.battery_pct > 0) {
            node.battery_pct -= 1;
            node.battery_mv = Math.max(280, Math.round((3.0 + (node.battery_pct / 100) * 1.2) * 100));
        }
        
        node.rssi = Math.max(-95, Math.min(-40, node.rssi + (Math.floor(Math.random() * 5) - 2)));
        
        requestUpdateUI();
    }, delay);

    simOfflineCheckInterval = setInterval(() => {
        if (!state.demoMode) return;
        
        Object.keys(state.nodes).forEach(id => {
            const node = state.nodes[id];
            const rand = Math.random() * 100;
            
            if (node.online && rand < 1.0) {
                node.online = false;
                node.last_seen_epoch = Math.floor(Date.now() / 1000);
            } else if (!node.online && rand < 5.0) {
                node.online = true;
                node.last_seen_epoch = Math.floor(Date.now() / 1000);
                node.battery_pct = Math.floor(Math.random() * 40) + 60;
                node.battery_mv = Math.round((3.0 + (node.battery_pct / 100) * 1.2) * 100);
            }
        });
        requestUpdateUI();
    }, 5000);
}

// Simulated mass presses
function triggerMassiveSimPresses() {
    if (!state.demoMode) return;
    
    const countToPress = Math.min(state.totalNodes, 300);
    const keys = Object.keys(state.nodes);
    
    for (let i = 0; i < countToPress; i++) {
        const randKey = keys[Math.floor(Math.random() * keys.length)];
        const node = state.nodes[randKey];
        if (node.online) {
            node.press_count += Math.floor(Math.random() * 5) + 1;
            node.last_seen_epoch = Math.floor(Date.now() / 1000);
        }
    }
    requestUpdateUI();
}

/* ==========================================================================
   UI UPDATER WITH RENDER FLUSH (THROTTLE)
   ========================================================================== */
function requestUpdateUI() {
    if (uiUpdateScheduled) return;
    uiUpdateScheduled = true;
    
    requestAnimationFrame(() => {
        recalculateStats();
        applyFiltersAndSort();
        renderNodeCards();
        drawFactoryGrid();
        updateCharts();
        uiUpdateScheduled = false;
    });
}

function recalculateStats() {
    const allNodes = Object.values(state.nodes);
    const total = allNodes.length;
    let online = 0;
    let offline = 0;
    let lowBattery = 0;
    let normalBattery = 0;
    let totalPress = 0;
    
    allNodes.forEach(node => {
        if (node.online) online++;
        else offline++;
        
        if (node.battery_pct < 20) lowBattery++;
        else normalBattery++;
        
        totalPress += node.press_count;
    });
    
    statTotalNodes.textContent = formatNumber(total);
    statOnlineNodes.textContent = formatNumber(online);
    statOfflineNodes.textContent = formatNumber(offline);
    statLowBattery.textContent = formatNumber(lowBattery);
    statNormalBattery.textContent = formatNumber(normalBattery);
    statTotalPressCount.textContent = formatNumber(totalPress);
}

function applyFiltersAndSort() {
    let list = Object.values(state.nodes);
    
    // Apply search query
    if (state.searchQuery.trim() !== '') {
        const query = state.searchQuery.toLowerCase();
        list = list.filter(node => 
            node.node_id.toString().includes(query)
        );
    }
    
    // Apply Group (Tổ) filter
    if (state.groupFilter !== 'all') {
        list = list.filter(node => node.group === state.groupFilter);
    }

    // Apply Process (Công đoạn) filter
    if (state.processFilter !== 'all') {
        list = list.filter(node => node.process === state.processFilter);
    }

    // Apply status filter
    if (state.statusFilter !== 'all') {
        const isOnlineTarget = state.statusFilter === 'online';
        list = list.filter(node => node.online === isOnlineTarget);
    }
    
    // Apply battery filter
    if (state.batteryFilter !== 'all') {
        if (state.batteryFilter === 'low') {
            list = list.filter(node => node.battery_pct < 20);
        } else {
            list = list.filter(node => node.battery_pct >= 20);
        }
    }
    
    // Apply sorting
    list.sort((a, b) => {
        switch (state.sortBy) {
            case 'id_desc':
                return b.node_id - a.node_id;
            case 'press_desc':
                return b.press_count - a.press_count;
            case 'press_asc':
                return a.press_count - b.press_count;
            case 'battery_asc':
                return a.battery_pct - b.battery_pct;
            case 'rssi_desc':
                return b.rssi - a.rssi;
            case 'id_asc':
            default:
                return a.node_id - b.node_id;
        }
    });
    
    state.filteredNodeIds = list.map(node => node.node_id);
}

/* ==========================================================================
   DOM CARD RENDERING & PAGINATION
   ========================================================================== */
function renderNodeCards() {
    nodesContainer.innerHTML = '';
    
    const totalFiltered = state.filteredNodeIds.length;
    if (totalFiltered === 0) {
        nodesContainer.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                <i data-lucide="info" style="width: 48px; height: 48px; margin: 0 auto 12px; opacity: 0.5;"></i>
                <p>Không tìm thấy thiết bị nào khớp với bộ lọc.</p>
            </div>
        `;
        lucide.createIcons();
        updatePaginationUI(0, 0, 0);
        return;
    }
    
    const maxPages = Math.ceil(totalFiltered / state.itemsPerPage);
    if (state.currentPage > maxPages) state.currentPage = Math.max(1, maxPages);
    
    const startIndex = (state.currentPage - 1) * state.itemsPerPage;
    const endIndex = Math.min(startIndex + state.itemsPerPage, totalFiltered);
    
    const pageNodeIds = state.filteredNodeIds.slice(startIndex, endIndex);
    
    pageNodeIds.forEach(id => {
        const node = state.nodes[id];
        const card = createNodeCardElement(node);
        nodesContainer.appendChild(card);
    });
    
    lucide.createIcons();
    updatePaginationUI(startIndex + 1, endIndex, totalFiltered);
}

function createNodeCardElement(node) {
    const card = document.createElement('div');
    card.className = `node-card ${node.online ? 'online' : 'offline'}`;
    card.onclick = () => openNodeModal(node.node_id);
    
    const batteryClass = node.battery_pct < 20 ? 'battery-critical' : (node.battery_pct < 40 ? 'battery-low' : 'battery-good');
    const batteryIconName = node.battery_pct < 10 ? 'battery' : (node.battery_pct < 35 ? 'battery-low' : (node.battery_pct < 75 ? 'battery-medium' : 'battery'));
    
    const absRssi = Math.abs(node.rssi);
    const rssiClass = absRssi < 60 ? 'rssi-excellent' : (absRssi < 75 ? 'rssi-good' : (absRssi < 88 ? 'rssi-fair' : 'rssi-poor'));
    
    const uptimeText = formatUptime(node.gateway_uptime_ms);
    const relativeTime = getRelativeTime(node.last_seen_epoch);
    
    const batteryVoltage = node.battery_mv > 1000 ? (node.battery_mv / 1000).toFixed(2) : (node.battery_mv > 100 ? (node.battery_mv / 100).toFixed(2) : node.battery_mv.toFixed(2));
    
    card.innerHTML = `
        <div class="node-header">
            <div class="node-title">
                <i data-lucide="hash" style="width: 14px; height: 14px; color: var(--primary);"></i>
                Máy May #${node.node_id}
            </div>
            <div class="node-badge ${node.online ? 'online' : 'offline'}">
                <i data-lucide="${node.online ? 'zap' : 'zap-off'}" style="width: 10px; height: 10px;"></i>
                ${node.online ? 'Online' : 'Offline'}
            </div>
        </div>
        
        <div class="card-tags">
            <span class="card-tag group-tag">${node.group}</span>
            <span class="card-tag process-tag">${node.process}</span>
        </div>
        
        <div class="counter-section">
            <span>Sản lượng hoàn thành</span>
            <div class="counter-value">${formatNumber(node.press_count)}</div>
        </div>
        
        <div class="params-grid">
            <div class="param-item">
                <span class="param-label">Điện áp PIN</span>
                <span class="param-value ${batteryClass}">
                    <i data-lucide="${batteryIconName}"></i>
                    ${batteryVoltage}V (${node.battery_pct}%)
                </span>
            </div>
            <div class="param-item">
                <span class="param-label">Tín hiệu sóng</span>
                <span class="param-value ${rssiClass}">
                    <i data-lucide="signal"></i>
                    ${node.rssi} dBm
                </span>
            </div>
            <div class="param-item" style="grid-column: span 2">
                <span class="param-label">Cổng Gateway Uptime</span>
                <span class="param-value">
                    <i data-lucide="clock"></i>
                    ${uptimeText}
                </span>
            </div>
        </div>
        
        <div class="last-seen">
            Cập nhật: ${relativeTime}
        </div>
    `;
    
    return card;
}

function updatePaginationUI(start, end, total) {
    paginationInfo.textContent = `Hiển thị ${start} - ${end} trong tổng số ${formatNumber(total)} thiết bị`;
    
    paginationControls.innerHTML = '';
    const maxPages = Math.ceil(total / state.itemsPerPage);
    if (maxPages <= 1) return;
    
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.disabled = state.currentPage === 1;
    prevBtn.innerHTML = '<i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i>';
    prevBtn.onclick = () => {
        state.currentPage--;
        requestUpdateUI();
    };
    paginationControls.appendChild(prevBtn);
    
    let pages = [];
    const windowSize = 1;
    
    for (let i = 1; i <= maxPages; i++) {
        if (i === 1 || i === maxPages || (i >= state.currentPage - windowSize && i <= state.currentPage + windowSize)) {
            pages.push(i);
        } else if (pages[pages.length - 1] !== '...') {
            pages.push('...');
        }
    }
    
    pages.forEach(p => {
        if (p === '...') {
            const dots = document.createElement('span');
            dots.textContent = '...';
            dots.style.color = 'var(--text-muted)';
            dots.style.padding = '0 6px';
            paginationControls.appendChild(dots);
        } else {
            const pageBtn = document.createElement('button');
            pageBtn.className = `page-btn ${p === state.currentPage ? 'active' : ''}`;
            pageBtn.textContent = p;
            pageBtn.onclick = () => {
                state.currentPage = p;
                requestUpdateUI();
            };
            paginationControls.appendChild(pageBtn);
        }
    });
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.disabled = state.currentPage === maxPages;
    nextBtn.innerHTML = '<i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>';
    nextBtn.onclick = () => {
        state.currentPage++;
        requestUpdateUI();
    };
    paginationControls.appendChild(nextBtn);
    
    lucide.createIcons();
}

/* ==========================================================================
   CANVAS FACTORY GRID VIEW (10K SCALING OVERVIEW)
   ========================================================================== */
function drawFactoryGrid() {
    const ctx = factoryCanvas.getContext('2d');
    const width = factoryCanvas.width;
    const height = factoryCanvas.height;
    
    ctx.clearRect(0, 0, width, height);
    
    if (state.totalNodes === 0) return;
    
    const aspect = width / height; // 1200 / 600 = 2
    const cols = Math.ceil(Math.sqrt(state.totalNodes * aspect));
    const rows = Math.ceil(state.totalNodes / cols);
    
    const spacing = 1.5;
    const cellW = (width - (spacing * (cols + 1))) / cols;
    const cellH = (height - (spacing * (rows + 1))) / rows;
    
    const filteredSet = new Set(state.filteredNodeIds);
    
    ctx.save();
    
    for (let i = 0; i < state.totalNodes; i++) {
        const nodeId = i + 1;
        const node = state.nodes[nodeId];
        
        const col = i % cols;
        const row = Math.floor(i / cols);
        
        const x = spacing + col * (cellW + spacing);
        const y = spacing + row * (cellH + spacing);
        
        const isFilteredOut = !filteredSet.has(nodeId);
        
        if (isFilteredOut) {
            ctx.fillStyle = '#1e293b'; // Very dim background color
            ctx.globalAlpha = 0.15;    // Extremely low opacity to denote "filtered out"
        } else if (!node) {
            ctx.fillStyle = '#24324f';
            ctx.globalAlpha = 1.0;
        } else {
            ctx.globalAlpha = node.online ? 1.0 : 0.25;
            
            if (state.gridColorMode === 'status') {
                ctx.fillStyle = node.online ? '#10b981' : '#ef4444';
                if (node.online) ctx.globalAlpha = 1.0;
            } else if (state.gridColorMode === 'group') {
                ctx.fillStyle = COLORS.groups[node.group] || '#94a3b8';
            } else if (state.gridColorMode === 'process') {
                ctx.fillStyle = COLORS.processes[node.process] || '#94a3b8';
            }
        }
        
        // Hover Highlight overlay
        if (state.hoveredNodeId === nodeId) {
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = 1.0;
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#ffffff';
        } else {
            ctx.shadowBlur = 0;
        }
        
        ctx.fillRect(x, y, cellW, cellH);
    }
    
    ctx.restore();
}

function handleGridColorModeChange() {
    const select = document.getElementById('gridColorMode');
    state.gridColorMode = select.value;
    updateGridLegend();
    drawFactoryGrid();
}

function updateGridLegend() {
    if (state.gridColorMode === 'status') {
        gridLegend.innerHTML = `
            <div class="legend-item">
                <div class="legend-color online"></div>
                <span>Online</span>
            </div>
            <div class="legend-item">
                <div class="legend-color offline"></div>
                <span>Offline</span>
            </div>
            <div class="legend-item">
                <div class="legend-color unregistered"></div>
                <span>Chưa nhận tin</span>
            </div>
        `;
    } else if (state.gridColorMode === 'group') {
        gridLegend.innerHTML = `
            <div class="legend-item color-coded"><div class="legend-color g1"></div><span>Tổ 1</span></div>
            <div class="legend-item color-coded"><div class="legend-color g2"></div><span>Tổ 2</span></div>
            <div class="legend-item color-coded"><div class="legend-color g3"></div><span>Tổ 3</span></div>
            <div class="legend-item color-coded"><div class="legend-color g4"></div><span>Tổ 4</span></div>
            <div class="legend-item color-coded"><div class="legend-color g5"></div><span>Tổ 5</span></div>
            <div class="legend-item"><div class="legend-color offline" style="opacity: 0.25; background-color:#94a3b8;"></div><span>Offline (Mờ)</span></div>
        `;
    } else if (state.gridColorMode === 'process') {
        gridLegend.innerHTML = `
            <div class="legend-item color-coded"><div class="legend-color p1"></div><span>May Cổ</span></div>
            <div class="legend-item color-coded"><div class="legend-color p2"></div><span>Ráp Thân</span></div>
            <div class="legend-item color-coded"><div class="legend-color p3"></div><span>Tra Khóa</span></div>
            <div class="legend-item color-coded"><div class="legend-color p4"></div><span>Lên Gấu</span></div>
            <div class="legend-item color-coded"><div class="legend-color p5"></div><span>Vắt Sổ</span></div>
            <div class="legend-item"><div class="legend-color offline" style="opacity: 0.25; background-color:#94a3b8;"></div><span>Offline (Mờ)</span></div>
        `;
    }
}

function setupCanvasListeners() {
    factoryCanvas.addEventListener('mousemove', (event) => {
        if (state.totalNodes === 0) return;
        
        const rect = factoryCanvas.getBoundingClientRect();
        const scaleX = factoryCanvas.width / rect.width;
        const scaleY = factoryCanvas.height / rect.height;
        
        const mouseX = (event.clientX - rect.left) * scaleX;
        const mouseY = (event.clientY - rect.top) * scaleY;
        
        const width = factoryCanvas.width;
        const height = factoryCanvas.height;
        
        const aspect = width / height;
        const cols = Math.ceil(Math.sqrt(state.totalNodes * aspect));
        const rows = Math.ceil(state.totalNodes / cols);
        
        const spacing = 1.5;
        const cellW = (width - (spacing * (cols + 1))) / cols;
        const cellH = (height - (spacing * (rows + 1))) / rows;
        
        const colIndex = Math.floor((mouseX - spacing) / (cellW + spacing));
        const rowIndex = Math.floor((mouseY - spacing) / (cellH + spacing));
        
        let hoveredId = null;
        if (colIndex >= 0 && colIndex < cols && rowIndex >= 0 && rowIndex < rows) {
            const index = rowIndex * cols + colIndex;
            if (index < state.totalNodes) {
                hoveredId = index + 1;
            }
        }
        
        if (state.hoveredNodeId !== hoveredId) {
            state.hoveredNodeId = hoveredId;
            drawFactoryGrid();
            
            if (hoveredId) {
                const node = state.nodes[hoveredId];
                showGridTooltip(event, node, hoveredId);
            } else {
                hideGridTooltip();
            }
        } else if (hoveredId) {
            positionTooltip(event);
        }
    });
    
    factoryCanvas.addEventListener('mouseleave', () => {
        state.hoveredNodeId = null;
        drawFactoryGrid();
        hideGridTooltip();
    });
    
    factoryCanvas.addEventListener('click', () => {
        if (state.hoveredNodeId) {
            openNodeModal(state.hoveredNodeId);
        }
    });
}

function showGridTooltip(event, node, id) {
    if (!node) {
        gridTooltip.innerHTML = `<strong>Máy May #${id}</strong><br><span style="color: var(--text-muted)">Chưa kết nối</span>`;
    } else {
        const batteryVoltage = node.battery_mv > 1000 ? (node.battery_mv / 1000).toFixed(2) : (node.battery_mv > 100 ? (node.battery_mv / 100).toFixed(2) : node.battery_mv.toFixed(2));
        gridTooltip.innerHTML = `
            <div style="font-weight: 700; border-bottom: 1px solid var(--border-color); padding-bottom: 4px; margin-bottom: 4px;">
                Máy May #${id} (${node.group} - ${node.process})
            </div>
            <strong>Trạng thái:</strong> <span style="color: ${node.online ? 'var(--success)' : 'var(--danger)'}">${node.online ? 'ONLINE' : 'OFFLINE'}</span><br>
            <strong>Sản lượng:</strong> ${formatNumber(node.press_count)} sản phẩm<br>
            <strong>Điện áp Pin:</strong> ${batteryVoltage}V (${node.battery_pct}%)<br>
            <strong>RSSI:</strong> ${node.rssi} dBm
        `;
    }
    gridTooltip.style.display = 'block';
    positionTooltip(event);
}

function positionTooltip(event) {
    const offset = 15;
    gridTooltip.style.left = `${event.clientX + offset}px`;
    gridTooltip.style.top = `${event.clientY + offset}px`;
}

function hideGridTooltip() {
    gridTooltip.style.display = 'none';
}

/* ==========================================================================
   CHARTS AND ANALYTICS (CHART.JS)
   ========================================================================== */
function initCharts() {
    const ctxStatus = document.getElementById('statusChart').getContext('2d');
    const ctxBattery = document.getElementById('batteryChart').getContext('2d');
    const ctxGroup = document.getElementById('groupProductionChart').getContext('2d');
    const ctxTop = document.getElementById('topProductionChart').getContext('2d');
    
    // Status distribution
    statusChartInstance = new Chart(ctxStatus, {
        type: 'doughnut',
        data: {
            labels: ['Online', 'Offline'],
            datasets: [{
                data: [0, 0],
                backgroundColor: ['#10b981', '#ef4444'],
                borderWidth: 1,
                borderColor: '#141c2f'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#94a3b8', font: { family: 'Inter' } }
                }
            }
        }
    });

    // Battery health bar chart
    batteryChartInstance = new Chart(ctxBattery, {
        type: 'bar',
        data: {
            labels: ['Yếu (<20%)', 'Bình Thường'],
            datasets: [{
                label: 'Số lượng thiết bị',
                data: [0, 0],
                backgroundColor: ['#ef4444', '#10b981'],
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
                y: { grid: { color: '#24324f' }, ticks: { color: '#94a3b8' } }
            }
        }
    });

    // Group Production chart (New!)
    groupProductionChartInstance = new Chart(ctxGroup, {
        type: 'bar',
        data: {
            labels: ['Tổ 1', 'Tổ 2', 'Tổ 3', 'Tổ 4', 'Tổ 5'],
            datasets: [{
                label: 'Tổng sản lượng tổ',
                data: [0, 0, 0, 0, 0],
                backgroundColor: ['#06b6d4', '#3b82f6', '#a855f7', '#f97316', '#ec4899'],
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
                y: { grid: { color: '#24324f' }, ticks: { color: '#94a3b8' } }
            }
        }
    });

    // Top 10 machines
    topProductionChartInstance = new Chart(ctxTop, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Sản lượng đã may',
                data: [],
                backgroundColor: '#06b6d4',
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: { grid: { color: '#24324f' }, ticks: { color: '#94a3b8' } },
                y: { grid: { display: false }, ticks: { color: '#94a3b8' } }
            }
        }
    });
}

// Throttle chart updates
let lastChartUpdate = 0;
function updateCharts() {
    const now = Date.now();
    if (now - lastChartUpdate < 2000) return;
    lastChartUpdate = now;
    
    if (!statusChartInstance || !batteryChartInstance || !groupProductionChartInstance || !topProductionChartInstance) return;
    
    const allNodes = Object.values(state.nodes);
    if (allNodes.length === 0) return;
    
    // 1. Status Data
    let onlineCount = 0;
    let offlineCount = 0;
    
    // 2. Battery Data
    let batteryCritical = 0;
    let batteryGood = 0;
    
    // 3. Group Production Data
    const groupTotals = { 'Tổ 1': 0, 'Tổ 2': 0, 'Tổ 3': 0, 'Tổ 4': 0, 'Tổ 5': 0 };
    
    allNodes.forEach(node => {
        if (node.online) onlineCount++;
        else offlineCount++;
        
        if (node.battery_pct < 20) batteryCritical++;
        else batteryGood++;
        
        if (groupTotals[node.group] !== undefined) {
            groupTotals[node.group] += node.press_count;
        }
    });
    
    // Update Connection Status Donut
    statusChartInstance.data.datasets[0].data = [onlineCount, offlineCount];
    statusChartInstance.update();
    
    // Update Battery Status Bar
    batteryChartInstance.data.datasets[0].data = [batteryCritical, batteryGood];
    batteryChartInstance.update();
    
    // Update Group Production Bar
    groupProductionChartInstance.data.datasets[0].data = [
        groupTotals['Tổ 1'],
        groupTotals['Tổ 2'],
        groupTotals['Tổ 3'],
        groupTotals['Tổ 4'],
        groupTotals['Tổ 5']
    ];
    groupProductionChartInstance.update();
    
    // Update Top 10 Production Bar
    const sorted = [...allNodes].sort((a, b) => b.press_count - a.press_count).slice(0, 10);
    topProductionChartInstance.data.labels = sorted.map(node => `Máy #${node.node_id}`);
    topProductionChartInstance.data.datasets[0].data = sorted.map(node => node.press_count);
    topProductionChartInstance.update();
}

/* ==========================================================================
   DETAIL MODAL CONTROLLER
   ========================================================================== */
function openNodeModal(nodeId) {
    const node = state.nodes[nodeId];
    if (!node) return;
    
    state.selectedNodeId = nodeId;
    
    const modal = document.getElementById('nodeModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBadge = document.getElementById('modalBadge');
    const modalPressCount = document.getElementById('modalPressCount');
    const modalBattery = document.getElementById('modalBattery');
    const modalRssi = document.getElementById('modalRssi');
    const modalGroup = document.getElementById('modalGroup');
    const modalProcess = document.getElementById('modalProcess');
    const modalUptime = document.getElementById('modalUptime');
    const modalEvent = document.getElementById('modalEvent');
    const modalLastSeen = document.getElementById('modalLastSeen');
    
    modalTitle.innerHTML = `<i data-lucide="cpu" style="width: 20px; height: 20px; color: var(--primary);"></i> Máy May #${node.node_id}`;
    
    modalBadge.className = `node-badge ${node.online ? 'online' : 'offline'}`;
    modalBadge.innerHTML = `<i data-lucide="${node.online ? 'zap' : 'zap-off'}" style="width: 10px; height: 10px;"></i> ${node.online ? 'Online' : 'Offline'}`;
    
    modalPressCount.textContent = formatNumber(node.press_count);
    
    const batteryVoltage = node.battery_mv > 1000 ? (node.battery_mv / 1000).toFixed(2) : (node.battery_mv > 100 ? (node.battery_mv / 100).toFixed(2) : node.battery_mv.toFixed(2));
    modalBattery.innerHTML = `<i data-lucide="battery"></i> ${batteryVoltage} V (${node.battery_pct}%)`;
    
    modalRssi.innerHTML = `<i data-lucide="signal"></i> ${node.rssi} dBm`;
    modalGroup.innerHTML = `<i data-lucide="users"></i> ${node.group}`;
    modalProcess.innerHTML = `<i data-lucide="workflow"></i> ${node.process}`;
    modalUptime.innerHTML = `<i data-lucide="clock"></i> ${formatUptime(node.gateway_uptime_ms)}`;
    modalEvent.innerHTML = `<i data-lucide="activity"></i> ${node.event}`;
    
    const date = new Date(node.last_seen_epoch * 1000);
    modalLastSeen.textContent = `Cập nhật lần cuối: ${date.toLocaleString('vi-VN')} (${getRelativeTime(node.last_seen_epoch)})`;
    
    modal.classList.add('show');
    lucide.createIcons();
}

function closeModal(event) {
    const modal = document.getElementById('nodeModal');
    modal.classList.remove('show');
    state.selectedNodeId = null;
}

/* ==========================================================================
   TAB NAVIGATOR & USER CONTROLS
   ========================================================================== */
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    
    document.getElementById(`tab-${tabId}`).classList.add('active');
    event.currentTarget.classList.add('active');
    
    if (tabId === 'grid') {
        setTimeout(() => {
            updateGridLegend();
            drawFactoryGrid();
        }, 50);
    }
}

function toggleSimPanel() {
    const panel = document.getElementById('simPanel');
    panel.classList.toggle('show');
}

function updateSimCountLabel() {
    const slider = document.getElementById('simNodeCount');
    const label = document.getElementById('simCountLabel');
    state.totalNodes = parseInt(slider.value, 10);
    label.textContent = `${formatNumber(state.totalNodes)} Node`;
    
    if (state.demoMode) {
        reseedSimulator();
    }
}

function updateSimPressLabel() {
    const slider = document.getElementById('simPressRate');
    const label = document.getElementById('simPressLabel');
    state.pressRate = parseInt(slider.value, 10);
    label.textContent = `${state.pressRate} Lần/giây`;
    
    if (state.demoMode) {
        startSimulationLoops();
    }
}

function updateSimOfflineLabel() {
    const slider = document.getElementById('simOfflineRate');
    const label = document.getElementById('simOfflineLabel');
    state.offlineRate = parseInt(slider.value, 10);
    label.textContent = `${state.offlineRate}% Offline`;
}

function handleSearch() {
    state.searchQuery = document.getElementById('nodeSearch').value;
    state.currentPage = 1;
    requestUpdateUI();
}

function handleFilters() {
    state.groupFilter = document.getElementById('groupFilter').value;
    state.processFilter = document.getElementById('processFilter').value;
    state.statusFilter = document.getElementById('statusFilter').value;
    state.batteryFilter = document.getElementById('batteryFilter').value;
    state.currentPage = 1;
    requestUpdateUI();
}

function handleSort() {
    state.sortBy = document.getElementById('sortFilter').value;
    state.currentPage = 1;
    requestUpdateUI();
}

function handleHeartbeatTimeoutChange() {
    const select = document.getElementById('heartbeatTimeout');
    state.heartbeatTimeout = parseInt(select.value, 10);
    requestUpdateUI();
}

function startWatchdog() {
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = setInterval(() => {
        if (state.demoMode) return; // Bypassed in simulator mode to preserve demo grid layout
        
        const nowEpoch = Math.floor(Date.now() / 1000);
        let updated = false;
        
        Object.values(state.nodes).forEach(node => {
            if (node.online) {
                const inactiveSec = nowEpoch - node.last_seen_epoch;
                if (inactiveSec > state.heartbeatTimeout) {
                    node.online = false;
                    updated = true;
                }
            }
        });
        
        if (updated) {
            requestUpdateUI();
        }
    }, 5000); // Check every 5 seconds
}

/* ==========================================================================
   FORMATTER & UTILITY FUNCTIONS
   ========================================================================== */
function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatUptime(ms) {
    const sec = Math.floor(ms / 1000);
    const hrs = Math.floor(sec / 3600);
    const min = Math.floor((sec % 3600) / 60);
    const remainderSec = sec % 60;
    
    let text = '';
    if (hrs > 0) text += `${hrs}h `;
    if (min > 0 || hrs > 0) text += `${min}m `;
    text += `${remainderSec}s`;
    return text;
}

function getRelativeTime(epoch) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - epoch;
    
    if (diff < 5) return 'Vừa mới đây';
    if (diff < 60) return `${diff} giây trước`;
    
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins} phút trước`;
    
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} giờ trước`;
    
    const days = Math.floor(hrs / 24);
    return `${days} ngày trước`;
}
