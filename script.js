// Dynasty Baseball Draft Tracker
// Simple, stable, and fast draft management system

class DraftTracker {
    constructor() {
        this.players = [];
        this.currentView = 'all';
        this.currentOwner = '';
        this.currentPositionFilter = '';
        this.searchTerm = '';
        this.sortField = null;
        this.sortDirection = 'asc';
        this.currentEditingPlayer = null;
        this.supabase = null;
        this.editMode = false;
        this.expandedNotes = new Set();

        // Rankings state
        this.rankingsView = 'overall';
        this.rankings = [];
        this.hideDraftedInRankings = false;
        this.rankingsSearchTerm = '';

        // Owners state
        this.owners = []; // Array of {id: uuid, name: string}

        this.init();
    }

    async init() {
        this.initializeSupabase();
        await this.loadOwners(); // Load owners first
        this.loadFromStorage();
        this.ensureAllPlayersHaveUUIDs(); // Ensure UUIDs before any sync
        this.bindEvents();
        this.updateOwnerSelect();
        this.setupRealtimeSync();
        this.render();
        console.log('DraftTracker initialized - owners loaded:', this.owners.length);
    }

    // Supabase integration
    initializeSupabase() {
        try {
            if (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url && window.SUPABASE_CONFIG.anonKey) {
                this.supabase = window.supabase.createClient(
                    window.SUPABASE_CONFIG.url,
                    window.SUPABASE_CONFIG.anonKey
                );
                console.log('Supabase client initialized successfully');
            } else {
                console.warn('Supabase configuration not found. Running in local-only mode.');
                this.disableSyncButtons();
            }
        } catch (error) {
            console.error('Error initializing Supabase:', error);
            this.disableSyncButtons();
        }
    }

    disableSyncButtons() {
        const loadBtn = document.getElementById('loadFromSupabaseBtn');
        const backupBtn = document.getElementById('backupToSupabaseBtn');
        if (loadBtn) loadBtn.disabled = true;
        if (backupBtn) backupBtn.disabled = true;
    }

    // Load owners from Supabase
    async loadOwners() {
        if (!this.supabase) {
            console.warn('Supabase not available for loading owners');
            return;
        }

        try {
            console.log('📥 Loading owners from Supabase...');
            const { data, error } = await this.supabase
                .from('owners')
                .select('id, name')
                .order('name');

            if (error) {
                console.error('Error loading owners:', error);
                this.owners = [];
            } else {
                this.owners = data || [];
                console.log('✅ Loaded', this.owners.length, 'owners:', this.owners.map(o => o.name));
            }
        } catch (error) {
            console.error('Error loading owners:', error);
            this.owners = [];
        }
    }

    setSyncStatus(message, type = '') {
        const statusElement = document.getElementById('syncStatus');
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.className = 'sync-status';
            if (type) {
                statusElement.classList.add(type);
            }

            // Clear status after 3 seconds for success/error messages
            if (type === 'success' || type === 'error') {
                setTimeout(() => {
                    statusElement.textContent = '';
                    statusElement.className = 'sync-status';
                }, 3000);
            }
        }
    }

    async loadFromSupabase() {
        if (!this.supabase) {
            this.setSyncStatus('Supabase not configured', 'error');
            return;
        }

        try {
            this.setSyncStatus('Loading...', 'loading');

            const { data, error } = await this.supabase
                .from('players')
                .select('*')
                .order('name');

            if (error) {
                throw error;
            }

            if (data && data.length > 0) {
                console.log('📥 Loading', data.length, 'players from Supabase');

                // Convert Supabase data to our format and ensure valid IDs
                const supabasePlayers = data.map(player => {
                    let playerId = player.id.toString();

                    // Check if Supabase ID is invalid (team name instead of UUID)
                    const isInvalidId = !playerId ||
                        typeof playerId !== 'string' ||
                        playerId.length < 20 ||  // UUIDs are longer than team names
                        !playerId.includes('-') ||  // UUIDs have hyphens
                        playerId.match(/^[a-zA-Z]+$/);  // Team names are just letters

                    if (isInvalidId) {
                        console.log('🚨 INVALID ID from Supabase:', player.name, 'ID:', playerId, 'length:', playerId.length);
                    } else {
                        console.log('✅ Valid ID from Supabase:', player.name, 'ID:', playerId.substring(0, 8) + '...');
                    }

                    return {
                        id: playerId,
                        name: player.name || '',
                        position: player.position || '',
                        mlbTeam: player.team || '',
                        notes: player.notes || '',
                        fantasyOwner: player.owner_id || '',
                        drafted: player.drafted || false,
                        draftNotes: player.draft_notes || '',
                        addedDate: player.created_at || new Date().toISOString()
                    };
                });

                console.log('🔄 Starting merge with', supabasePlayers.length, 'Supabase players');
                // Merge with existing local data, preserving local draft info
                this.mergeSupabaseData(supabasePlayers);

                this.setSyncStatus(`Loaded ${data.length} players from Supabase`, 'success');
            } else {
                this.setSyncStatus('No players found in Supabase', 'error');
            }
        } catch (error) {
            console.error('Error loading from Supabase:', error);
            this.setSyncStatus('Error loading from Supabase', 'error');
        }
    }

    mergeSupabaseData(supabasePlayers) {
        // Create a map of existing players by ID for accurate lookup
        const existingPlayerMap = new Map();
        this.players.forEach(player => {
            existingPlayerMap.set(player.id, player);
        });

        // Track which local players have been updated
        const updatedLocalIds = new Set();

        // Merge data using ID matching
        supabasePlayers.forEach(supabasePlayer => {
            // Ensure Supabase player has valid ID
            const isInvalidId = !supabasePlayer.id ||
                typeof supabasePlayer.id !== 'string' ||
                supabasePlayer.id.length < 20 ||  // UUIDs are longer than team names
                !supabasePlayer.id.includes('-') ||  // UUIDs have hyphens
                supabasePlayer.id.match(/^[a-zA-Z]+$/);  // Team names are just letters

            if (isInvalidId) {
                console.log('🔧 Supabase player has invalid ID, skipping merge:', supabasePlayer.name, supabasePlayer.id);
                return; // Skip merging players with invalid IDs
            }

            const existingPlayer = existingPlayerMap.get(supabasePlayer.id);

            if (existingPlayer) {
                // Update ALL fields from Supabase
                const wasDraftedLocally = existingPlayer.drafted;
                const localOwner = existingPlayer.fantasyOwner;
                const localNotes = existingPlayer.draftNotes;
                const localDraftDate = existingPlayer.draftedDate;

                // Copy all Supabase data
                Object.assign(existingPlayer, supabasePlayer);

                // Preserve local draft info if it exists and Supabase doesn't have it
                if (wasDraftedLocally && (!supabasePlayer.drafted || supabasePlayer.drafted === false)) {
                    existingPlayer.drafted = true;
                    existingPlayer.fantasyOwner = localOwner;
                    existingPlayer.draftNotes = localNotes;
                    existingPlayer.draftedDate = localDraftDate;
                }

                updatedLocalIds.add(existingPlayer.id);
            } else {
                // Add new player from Supabase
                this.players.push(supabasePlayer);
            }
        });

        this.saveToStorage();
        this.render();
    }

    async backupToSupabase() {
        if (!this.supabase) {
            this.setSyncStatus('Supabase not configured', 'error');
            return;
        }

        try {
            this.setSyncStatus('Backing up...', 'loading');

            // Convert our data format to Supabase format
            const supabaseData = this.players.map(player => {
                // Ensure ID is a valid UUID - convert any invalid IDs
                let playerId = player.id;
                console.log('📋 Processing player:', player.name, 'ID:', playerId, 'length:', playerId?.length);

                const isInvalidId = !playerId ||
                    typeof playerId !== 'string' ||
                    playerId.length < 20 ||  // UUIDs are longer than team names
                    !playerId.includes('-') ||  // UUIDs have hyphens
                    playerId.match(/^[a-zA-Z]+$/);  // Team names are just letters

                console.log('🔍 isInvalidId check:', {
                    notPlayerId: !playerId,
                    notString: typeof playerId !== 'string',
                    tooShort: playerId?.length < 20,
                    noHyphen: !playerId?.includes('-'),
                    onlyLetters: playerId?.match(/^[a-zA-Z]+$/),
                    result: isInvalidId
                });

                if (isInvalidId) {
                    console.log('🔧 Fixing invalid ID for player:', player.name, 'old ID:', playerId);
                    playerId = crypto.randomUUID();
                    // Update the local player object too
                    player.id = playerId;
                    console.log('✅ New UUID:', playerId);
                } else {
                    console.log('✅ ID is already valid for player:', player.name);
                }

                // Only send owner_id if it's a valid UUID, otherwise send null
                let ownerId = null;
                if (player.fantasyOwner) {
                    const isValidOwnerId = typeof player.fantasyOwner === 'string' &&
                        player.fantasyOwner.length >= 20 &&
                        player.fantasyOwner.includes('-') &&
                        !player.fantasyOwner.match(/^[a-zA-Z]+$/); // Not just letters

                    if (isValidOwnerId) {
                        ownerId = player.fantasyOwner;
                    } else {
                        console.log('⚠️ Invalid owner_id for player:', player.name, 'value:', player.fantasyOwner, '- sending null');
                    }
                }

                const dataToSend = {
                    id: playerId,
                    name: player.name,
                    position: player.position || null,
                    team: player.mlbTeam || null,
                    notes: player.notes || null,
                    owner_id: ownerId,
                    drafted: player.drafted || false,
                    draft_notes: player.draftNotes || null,
                    updated_at: new Date().toISOString()
                };

                console.log('📤 Sending to Supabase:', player.name, 'ID:', dataToSend.id, 'owner_id:', dataToSend.owner_id);
                return dataToSend;
            });

            // Use individual operations to handle duplicates properly
            let successCount = 0;
            let errorCount = 0;

            for (const playerData of supabaseData) {
                try {
                    const { error } = await this.supabase
                        .from('players')
                        .upsert(playerData, { onConflict: 'id' });

                    if (error) {
                        console.error('Error backing up player:', playerData.name, error);
                        errorCount++;
                    } else {
                        successCount++;
                    }
                } catch (err) {
                    console.error('Exception backing up player:', playerData.name, err);
                    errorCount++;
                }
            }

            if (errorCount === 0) {
                this.setSyncStatus(`Backed up ${successCount} players to Supabase`, 'success');
            } else {
                this.setSyncStatus(`Backed up ${successCount} players, ${errorCount} failed`, 'error');
            }
        } catch (error) {
            console.error('Error backing up to Supabase:', error);
            this.setSyncStatus('Error backing up to Supabase', 'error');
        }
    }

    // Data persistence
    loadFromStorage() {
        const stored = localStorage.getItem('baseballDraftTracker');
        if (stored) {
            try {
                const data = JSON.parse(stored);
                this.players = data.players || [];
            } catch (e) {
                console.error('Error loading data:', e);
                this.players = [];
            }
        }
    }

    saveToStorage() {
        const data = {
            players: this.players,
            lastUpdated: new Date().toISOString()
        };
        localStorage.setItem('baseballDraftTracker', JSON.stringify(data));
    }

    // Player management
    addPlayer(playerData) {
        const player = {
            id: crypto.randomUUID(),
            name: playerData.name.trim(),
            position: playerData.position?.trim() || '',
            mlbTeam: playerData.mlbTeam?.trim() || '',
            notes: playerData.notes?.trim() || '',
            headshotUrl: playerData.headshotUrl?.trim() || '',
            fantasyOwner: '',
            drafted: false,
            draftNotes: '',
            starred: false,
            addedDate: new Date().toISOString()
        };

        this.players.push(player);
        this.saveToStorage();
        this.render();
        // Temporarily disable auto-sync for testing
        // this.autoSyncToSupabase();
        return player;
    }

    updatePlayer(playerId, updates) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== -1) {
            this.players[playerIndex] = { ...this.players[playerIndex], ...updates };
            this.saveToStorage();
            this.render();
            // Temporarily disable auto-sync for testing
            // this.autoSyncToSupabase();
        }
    }

    toggleStar(playerId) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== -1) {
            this.players[playerIndex].starred = !this.players[playerIndex].starred;
            this.saveToStorage();
            this.render();
        }
    }

    draftPlayer(playerId, ownerData) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.drafted = true;
            player.fantasyOwner = ownerData.owner.trim();
            player.draftNotes = ownerData.notes?.trim() || '';
            player.draftedDate = new Date().toISOString();
            this.saveToStorage();
            this.render();
            // Temporarily disable auto-sync for testing
            // this.autoSyncToSupabase();
        }
    }

    undraftPlayer(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.drafted = false;
            player.fantasyOwner = '';
            player.draftNotes = '';
            delete player.draftedDate;
            this.saveToStorage();
            this.render();
            // Temporarily disable auto-sync for testing
            // this.autoSyncToSupabase();
        }
    }

    async deletePlayer(playerId) {
        // Find player before removing
        const player = this.players.find(p => p.id === playerId);
        if (!player) return;

        // Remove from local array
        this.players = this.players.filter(p => p.id !== playerId);
        this.saveToStorage();
        this.render();

        // Sync deletion to Supabase for collaboration
        if (this.supabase) {
            try {
                await this.supabase
                    .from('players')
                    .delete()
                    .eq('id', playerId);
                console.log('Player deleted from Supabase:', player.name);
            } catch (error) {
                console.error('Failed to delete from Supabase:', error);
                // Note: Player is already removed locally, but deletion failed remotely
                // Could add retry logic here if needed
            }
        }
    }

    // View and filtering
    getFilteredPlayers() {
        let filtered = [...this.players];

        // Apply view filter
        switch (this.currentView) {
            case 'available':
                filtered = filtered.filter(p => !p.drafted);
                break;
            case 'drafted':
                filtered = filtered.filter(p => p.drafted);
                break;
            case 'by-owner':
                if (this.currentOwner) {
                    filtered = filtered.filter(p => p.fantasyOwner === this.currentOwner);
                } else {
                    filtered = filtered.filter(p => p.drafted);
                }
                break;
            case 'starred':
                filtered = filtered.filter(p => p.starred);
                break;
        }

        // Apply position filter
        if (this.currentPositionFilter) {
            if (this.currentPositionFilter === 'P') {
                // Show all pitchers - check for any pitcher-related position
                filtered = filtered.filter(p => p.position && (
                    p.position.includes('P') ||
                    p.position.includes('SP') ||
                    p.position.includes('RP') ||
                    p.position.includes('CL') ||
                    p.position.includes('P/')
                ));
            } else {
                // Use regex to find the position anywhere in the string, properly delimited
                const positionRegex = new RegExp(`\\b${this.currentPositionFilter}\\b`, 'i');
                filtered = filtered.filter(p => p.position && positionRegex.test(p.position));
            }
        }

        // Apply search filter
        if (this.searchTerm) {
            const term = this.searchTerm.toLowerCase();
            filtered = filtered.filter(p =>
                p.name.toLowerCase().includes(term) ||
                p.position.toLowerCase().includes(term) ||
                p.mlbTeam.toLowerCase().includes(term) ||
                p.notes.toLowerCase().includes(term) ||
                p.fantasyOwner.toLowerCase().includes(term)
            );
        }

        // Apply sorting
        if (this.sortField) {
            filtered.sort((a, b) => {
                let aVal = a[this.sortField] || '';
                let bVal = b[this.sortField] || '';

                // Special handling for position sorting with logical hierarchy
                if (this.sortField === 'position') {
                    const positionOrder = this.getPositionHierarchy();
                    const aPos = positionOrder.indexOf(aVal.toUpperCase());
                    const bPos = positionOrder.indexOf(bVal.toUpperCase());

                    // If both positions are in the hierarchy, sort by hierarchy
                    if (aPos !== -1 && bPos !== -1) {
                        const diff = aPos - bPos;
                        return this.sortDirection === 'asc' ? diff : -diff;
                    }

                    // If one is in hierarchy and one isn't, prioritize the one in hierarchy
                    if (aPos !== -1 && bPos === -1) return this.sortDirection === 'asc' ? -1 : 1;
                    if (aPos === -1 && bPos !== -1) return this.sortDirection === 'asc' ? 1 : -1;

                    // If neither is in hierarchy, fall back to alphabetical
                    aVal = aVal.toLowerCase();
                    bVal = bVal.toLowerCase();
                } else {
                    // Case-insensitive string comparison for other fields
                    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
                    if (typeof bVal === 'string') bVal = bVal.toLowerCase();
                }

                if (aVal < bVal) return this.sortDirection === 'asc' ? -1 : 1;
                if (aVal > bVal) return this.sortDirection === 'asc' ? 1 : -1;
                return 0;
            });
        }

        return filtered;
    }

    getUniqueOwners() {
        const owners = new Set();
        this.players.forEach(p => {
            if (p.fantasyOwner) {
                owners.add(p.fantasyOwner);
            }
        });
        return Array.from(owners).sort();
    }

    // Rendering
    render() {
        const filteredPlayers = this.getFilteredPlayers();

        if (this.currentView === 'rankings') {
            this.renderRankingsView();
        } else if (this.currentView === 'by-owner') {
            this.renderOwnerRosters();
        } else {
            // Ensure we have the original table structure when not in special views
            this.ensureTableStructure();
            this.renderTable(filteredPlayers);

            // Show/hide empty state only for table view
            const tbody = document.getElementById('playersTableBody');
            const emptyState = document.getElementById('emptyState');
            if (tbody && emptyState) {
                if (filteredPlayers.length === 0) {
                    tbody.style.display = 'none';
                    emptyState.style.display = 'block';
                } else {
                    tbody.style.display = '';
                    emptyState.style.display = 'none';
                }
            }
        }
    }

    renderTable(players) {
        const tbody = document.getElementById('playersTableBody');
        tbody.innerHTML = '';

        players.forEach(player => {
            const row = document.createElement('tr');
            if (player.drafted) {
                row.classList.add('drafted');
                // Apply team gradient background
                const teamColors = this.getOwnerColors(player.fantasyOwner);
                if (teamColors) {
                    row.style.background = teamColors;
                    row.style.color = '#ffffff';
                }
            }

            const nameClass = this.editMode ? 'editable' : '';
            const positionClass = this.editMode ? 'editable' : '';
            const mlbTeamClass = this.editMode ? 'editable' : '';
            const notesClass = this.editMode ? 'editable' : '';
            const isExpanded = this.expandedNotes.has(player.id);

            row.innerHTML = `
                <td>
                    <div class="player-name ${nameClass}" data-field="name" data-id="${player.id}" data-player-name="${this.escapeHtml(player.name)}">
                        <span class="star-icon ${player.starred ? 'starred' : ''}" data-id="${player.id}" title="${player.starred ? 'Unstar player' : 'Star player'}">${player.starred ? '⭐' : '☆'}</span>
                        ${this.escapeHtml(player.name)}
                        ${this.getExternalLinks(player)}
                    </div>
                </td>
                <td>
                    <span class="position-badge ${positionClass}" data-field="position" data-id="${player.id}">${this.escapeHtml(player.position || '')}</span>
                </td>
                <td>
                    <div class="mlb-team ${mlbTeamClass}" data-field="mlbTeam" data-id="${player.id}">${this.escapeHtml(player.mlbTeam || '')}</div>
                </td>
                <td>
                    ${player.drafted ?
                        `<span class="fantasy-owner editable" data-field="fantasyOwner" data-id="${player.id}">${this.getOwnerDisplay(player.fantasyOwner)}</span>` :
                        '<span class="draft-status available">Available</span>'
                    }
                </td>
                <td>
                    <div class="notes ${notesClass}" data-field="notes" data-id="${player.id}" title="${this.escapeHtml(player.notes || '')}" ${player.drafted ? 'style="color: white"' : ''}>
                        ${this.escapeHtml(player.notes || '')}
                        ${!isExpanded ? '<span class="expand-icon">▼</span>' : '<span class="expand-icon">▲</span>'}
                    </div>
                </td>
                <td>
                    <div class="actions">
                        ${!player.drafted ?
                            `<button class="btn btn-success btn-sm draft-btn" data-id="${player.id}">Draft</button>` :
                            `<button class="btn btn-warning btn-sm undraft-btn" data-id="${player.id}">Undraft</button>`
                        }
                        <button class="btn btn-danger btn-sm delete-btn" data-id="${player.id}">Delete</button>
                    </div>
                </td>
            `;

            tbody.appendChild(row);
        });

        this.bindRowEvents();
    }

    renderOwnerRosters() {
        const container = document.querySelector('.table-container');
        const owners = this.getUniqueOwners();

        if (owners.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No drafted players found.</p></div>';
            return;
        }

        let html = '';
        owners.forEach(owner => {
            const ownerPlayers = this.players.filter(p => p.fantasyOwner === owner);

            html += `
                <div class="owner-roster">
                    <div class="owner-header">
                        ${this.escapeHtml(owner)} (${ownerPlayers.length} players)
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Position</th>
                                <th>MLB Team</th>
                                <th>Notes</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            ownerPlayers.forEach(player => {
                html += `
                    <tr>
                        <td><div class="player-name">${this.escapeHtml(player.name)}</div></td>
                        <td><span class="position-badge">${this.escapeHtml(player.position || '')}</span></td>
                        <td><div class="mlb-team">${this.escapeHtml(player.mlbTeam || '')}</div></td>
                        <td><div class="notes" title="${this.escapeHtml(player.notes || '')}">${this.escapeHtml(player.notes || '')}</div></td>
                        <td>
                            <div class="actions">
                                <button class="btn btn-warning btn-sm undraft-btn" data-id="${player.id}">Undraft</button>
                            </div>
                        </td>
                    </tr>
                `;
            });

            html += `
                        </tbody>
                    </table>
                </div>
            `;
        });

        container.innerHTML = html;
        this.bindRowEvents();
    }

    // Event handling
    bindEvents() {
        // Add player button
        document.getElementById('addPlayerBtn').addEventListener('click', () => {
            this.showAddPlayerModal();
        });

        // Clear all data
        document.getElementById('clearAllBtn').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all data? This cannot be undone.')) {
                this.clearAllData();
            }
        });

        // View selection
        document.getElementById('viewSelect').addEventListener('change', (e) => {
            const newView = e.target.value;
            console.log('View changing from', this.currentView, 'to', newView);

            this.currentView = newView;
            const ownerFilter = document.getElementById('ownerFilter');

            if (this.currentView === 'by-owner') {
                ownerFilter.style.display = 'flex';
                this.updateOwnerSelect();
                // Reset owner selection when entering by-owner view
                this.currentOwner = '';
                document.getElementById('ownerSelect').value = '';
            } else {
                ownerFilter.style.display = 'none';
                this.currentOwner = '';
            }

            // Force re-render to ensure view change takes effect
            this.render();
        });

        // Owner selection for by-owner view
        document.getElementById('ownerSelect').addEventListener('change', (e) => {
            this.currentOwner = e.target.value;
            this.render();
        });

        // Position filter
        document.getElementById('positionSelect').addEventListener('change', (e) => {
            this.currentPositionFilter = e.target.value;
            this.render();
        });

        // Search
        document.getElementById('searchInput').addEventListener('input', (e) => {
            this.searchTerm = e.target.value;
            this.render();
        });

        // Sort buttons
        document.getElementById('sortByName').addEventListener('click', () => {
            this.setSort('name');
        });

        document.getElementById('sortByTeam').addEventListener('click', () => {
            this.setSort('mlbTeam');
        });

        document.getElementById('sortByPosition').addEventListener('click', () => {
            this.setSort('position');
        });

        // Supabase sync buttons
        document.getElementById('loadFromSupabaseBtn').addEventListener('click', () => {
            this.loadFromSupabase();
        });

        document.getElementById('backupToSupabaseBtn').addEventListener('click', () => {
            this.backupToSupabase();
        });

        // Modal forms
        document.getElementById('addPlayerForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAddPlayer(e);
        });

        document.getElementById('draftPlayerForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleDraftPlayer(e);
        });

        // Modal close buttons
        document.querySelectorAll('.close, .close-modal').forEach(btn => {
            btn.addEventListener('click', () => {
                this.closeAllModals();
            });
        });

        // Click outside modal to close
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                this.closeAllModals();
            }
        });

        // Edit mode toggle
        document.getElementById('editModeToggle').addEventListener('change', (e) => {
            this.editMode = e.target.checked;
            this.render();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + N for new player
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                this.showAddPlayerModal();
            }

            // Ctrl/Cmd + S for backup to Supabase (save/sync)
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.backupToSupabase();
            }

            // Escape to close modals and close expanded notes
            if (e.key === 'Escape') {
                this.closeAllModals();
                this.closeAllExpandedNotes();
            }

            // Ctrl/Cmd + F to focus search
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                document.getElementById('searchInput').focus();
            }
        });
    }

    bindRowEvents() {
        // Star toggle buttons
        document.querySelectorAll('.star-icon').forEach(star => {
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                const playerId = e.target.dataset.id;
                this.toggleStar(playerId);
            });
        });

        // Draft/Undraft buttons
        document.querySelectorAll('.draft-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const playerId = e.target.dataset.id;
                this.showDraftPlayerModal(playerId);
            });
        });

        document.querySelectorAll('.undraft-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const playerId = e.target.dataset.id;
                this.undraftPlayer(playerId);
            });
        });

        // Delete buttons
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const playerId = e.target.dataset.id;
                if (confirm('Are you sure you want to delete this player?')) {
                    this.deletePlayer(playerId);
                }
            });
        });

        // Inline editing and note expansion
        document.querySelectorAll('.editable').forEach(elem => {
            elem.addEventListener('click', (e) => {
                e.stopPropagation();
                if (elem.classList.contains('notes')) {
                    // Notes can be expanded or edited based on edit mode
                    if (this.editMode) {
                        this.startInlineEdit(e.target);
                    } else {
                        this.toggleNoteExpansion(elem.dataset.id, elem);
                    }
                } else if (this.editMode) {
                    this.startInlineEdit(e.target);
                }
            });
        });

        // Player name expandable cards
        document.querySelectorAll('.player-name').forEach(elem => {
            // Only add click handler if it's not already editable (to avoid conflicts)
            if (!elem.classList.contains('editable')) {
                elem.addEventListener('click', (e) => {
                    // Don't expand if clicking on star icon
                    if (e.target.classList.contains('star-icon')) {
                        return; // Let star icon handle its own click
                    }

                    e.stopPropagation();
                    const playerId = elem.dataset.id;
                    this.togglePlayerCard(playerId);
                });
                elem.style.cursor = 'pointer';
            }
        });
    }

    // Modal management
    showAddPlayerModal() {
        document.getElementById('addPlayerModal').style.display = 'block';
        document.getElementById('playerName').focus();
    }

    showDraftPlayerModal(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player) return;

        document.getElementById('draftPlayerName').textContent = `${player.name} (${player.position || 'N/A'}) - ${player.mlbTeam || 'N/A'}`;
        document.getElementById('fantasyOwner').value = '';
        document.getElementById('draftNotes').value = '';
        document.getElementById('draftPlayerForm').dataset.playerId = playerId;
        document.getElementById('draftPlayerModal').style.display = 'block';
        document.getElementById('fantasyOwner').focus();

        // Setup autocomplete for fantasy owner
        this.setupOwnerAutocomplete();
    }

    closeAllModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.style.display = 'none';
        });
        this.currentEditingPlayer = null;
    }

    // Form handlers
    handleAddPlayer(e) {
        const formData = new FormData(e.target);
        const playerData = {
            name: formData.get('playerName'),
            position: formData.get('playerPosition'),
            mlbTeam: formData.get('playerMlbTeam'),
            notes: formData.get('playerNotes')
        };

        if (!playerData.name || !playerData.name.trim()) {
            alert('Player name is required');
            return;
        }

        this.addPlayer(playerData);
        this.closeAllModals();
        e.target.reset();

        // Switch to "all" view to show the newly added player
        if (this.currentView !== 'all') {
            this.currentView = 'all';
            document.getElementById('viewSelect').value = 'all';
            const ownerFilter = document.getElementById('ownerFilter');
            ownerFilter.style.display = 'none';
            this.currentOwner = '';
        }
    }

    handleDraftPlayer(e) {
        const form = e.target;
        const playerId = form.dataset.playerId;
        const ownerData = {
            owner: document.getElementById('fantasyOwner').value,
            notes: document.getElementById('draftNotes').value
        };

        // Validate owner is provided
        if (!ownerData.owner || !ownerData.owner.trim()) {
            alert('Please enter a fantasy owner/team name');
            return;
        }

        this.draftPlayer(playerId, ownerData);
        this.closeAllModals();
    }

    // Inline editing
    startInlineEdit(element) {
        if (this.currentEditingPlayer) return;

        const field = element.dataset.field;
        const playerId = element.dataset.id;
        const player = this.players.find(p => p.id === playerId);

        if (!player) return;

        const currentValue = player[field] || '';

        // Create the appropriate input element
        let input;
        if (field === 'notes') {
            input = document.createElement('textarea');
            input.rows = 2;
        } else {
            input = document.createElement('input');
            input.type = 'text';
        }

        input.value = currentValue;
        input.className = 'editing';
        input.style.color = 'black'; // Ensure text is readable during editing

        element.innerHTML = '';
        element.appendChild(input);
        input.focus();
        input.select();

        this.currentEditingPlayer = { playerId, field, element, originalValue: currentValue };

        const saveEdit = () => {
            const newValue = input.value.trim();
            this.updatePlayer(playerId, { [field]: newValue });
            this.currentEditingPlayer = null;
        };

        const cancelEdit = () => {
            this.render();
            this.currentEditingPlayer = null;
        };

        input.addEventListener('blur', saveEdit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && field !== 'notes') {
                e.preventDefault();
                saveEdit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
            }
        });
    }

    // Utility methods
    setSort(field) {
        if (this.sortField === field) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDirection = 'asc';
        }
        this.render();
    }

    updateOwnerSelect() {
        const select = document.getElementById('ownerSelect');
        const owners = this.getUniqueOwners();

        select.innerHTML = '<option value="">All Owners</option>';
        owners.forEach(owner => {
            const option = document.createElement('option');
            option.value = owner;
            option.textContent = owner;
            select.appendChild(option);
        });
    }

    setupOwnerAutocomplete() {
        const input = document.getElementById('fantasyOwner');

        // Create a select dropdown instead of datalist for better control
        let select = document.getElementById('fantasyOwnerSelect');
        if (!select) {
            select = document.createElement('select');
            select.id = 'fantasyOwnerSelect';
            select.className = 'form-control';
            input.parentNode.insertBefore(select, input);
            input.style.display = 'none'; // Hide the original input

            // Update form submission to use the select value
            select.addEventListener('change', (e) => {
                input.value = e.target.value; // Store UUID in hidden input
            });
        }

        // Clear existing options
        select.innerHTML = '<option value="">Select Owner...</option>';

        // Add owners from database
        this.owners.forEach(owner => {
            const option = document.createElement('option');
            option.value = owner.id; // Store UUID as value
            option.textContent = owner.name; // Display name
            select.appendChild(option);
        });

        // Also add any existing drafted owners that might not be in the database yet
        const existingOwners = this.getUniqueOwners();
        existingOwners.forEach(ownerName => {
            // Check if this owner name is already in the select (by name)
            const alreadyExists = Array.from(select.options).some(opt => opt.textContent === ownerName);
            if (!alreadyExists && ownerName.trim()) {
                const option = document.createElement('option');
                option.value = ownerName; // Keep existing behavior for backward compatibility
                option.textContent = ownerName;
                select.appendChild(option);
            }
        });
    }

    // Real-time sync setup
    setupRealtimeSync() {
        if (!this.supabase) {
            console.log('Real-time sync disabled - Supabase not configured');
            return;
        }

        console.log('Setting up real-time sync...');

        // Subscribe to player changes
        this.supabase
            .channel('players')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'players'
            }, (payload) => {
                console.log('Real-time update received:', payload);
                this.handleRealtimeUpdate(payload);
            })
            .subscribe((status) => {
                console.log('Real-time subscription status:', status);
            });
    }

    handleRealtimeUpdate(payload) {
        // Handle different types of changes
        if (payload.eventType === 'INSERT') {
            // New player added by someone else
            this.handleRealtimeInsert(payload.new);
        } else if (payload.eventType === 'UPDATE') {
            // Player updated by someone else
            this.handleRealtimeUpdate(payload.new);
        } else if (payload.eventType === 'DELETE') {
            // Player deleted by someone else
            this.handleRealtimeDelete(payload.old);
        }
    }

    handleRealtimeInsert(newPlayer) {
        // Convert Supabase format to our format
        const player = {
            id: newPlayer.id.toString(),
            name: newPlayer.name || '',
            position: newPlayer.position || '',
            mlbTeam: newPlayer.team || '',
            notes: newPlayer.notes || '',
            fantasyOwner: newPlayer.owner_id || '',
            drafted: newPlayer.drafted || false,
            draftNotes: newPlayer.draft_notes || '',
            addedDate: newPlayer.created_at || new Date().toISOString()
        };

        // Check if we already have this player
        const existingIndex = this.players.findIndex(p => p.id === player.id);
        if (existingIndex === -1) {
            // Add new player
            this.players.push(player);
            this.saveToStorage();
            this.render();
            console.log('Added player from real-time sync:', player.name);
        }
    }

    handleRealtimeUpdate(updatedPlayer) {
        // Convert Supabase format to our format
        const playerUpdate = {
            id: updatedPlayer.id.toString(),
            name: updatedPlayer.name || '',
            position: updatedPlayer.position || '',
            mlbTeam: updatedPlayer.team || '',
            notes: updatedPlayer.notes || '',
            fantasyOwner: updatedPlayer.owner_id || '',
            drafted: updatedPlayer.drafted || false,
            draftNotes: updatedPlayer.draft_notes || '',
            addedDate: updatedPlayer.created_at || new Date().toISOString()
        };

        // Find and update existing player
        const existingIndex = this.players.findIndex(p => p.id === playerUpdate.id);
        if (existingIndex !== -1) {
            // Only update if the data is actually different
            const currentPlayer = this.players[existingIndex];
            let hasChanges = false;

            Object.keys(playerUpdate).forEach(key => {
                if (currentPlayer[key] !== playerUpdate[key]) {
                    hasChanges = true;
                }
            });

            if (hasChanges) {
                this.players[existingIndex] = { ...currentPlayer, ...playerUpdate };
                this.saveToStorage();
                this.render();
                console.log('Updated player from real-time sync:', playerUpdate.name);
            }
        }
    }

    handleRealtimeDelete(deletedPlayer) {
        const playerId = deletedPlayer.id.toString();
        const existingIndex = this.players.findIndex(p => p.id === playerId);

        if (existingIndex !== -1) {
            this.players.splice(existingIndex, 1);
            this.saveToStorage();
            this.render();
            console.log('Deleted player from real-time sync:', deletedPlayer.name);
        }
    }

    // Ensure all players have proper UUIDs (convert any invalid IDs)
    ensureAllPlayersHaveUUIDs() {
        let updated = false;
        this.players.forEach(player => {
            const isInvalidId = !player.id ||
                typeof player.id !== 'string' ||
                player.id.length < 20 ||  // UUIDs are longer than team names
                !player.id.includes('-') ||  // UUIDs have hyphens
                player.id.match(/^[a-zA-Z]+$/);  // Team names are just letters

            if (isInvalidId) {
                console.log('🔧 Converting invalid ID for player:', player.name, 'from:', player.id);
                player.id = crypto.randomUUID();
                console.log('✅ New UUID:', player.id);
                updated = true;
            }
        });

        if (updated) {
            this.saveToStorage();
            console.log('💾 Saved converted IDs to storage');
        } else {
            console.log('✅ All player IDs are already valid UUIDs');
        }
    }

    // Auto-sync local changes to Supabase
    autoSyncToSupabase() {
        if (!this.supabase) return;

        // Use the same logic as backupToSupabase but silent
        const supabaseData = this.players.map(player => {
            // Ensure ID is a valid UUID - convert old timestamp IDs if needed
            let playerId = player.id;
            if (!playerId || typeof playerId === 'string' && /^\d+$/.test(playerId)) {
                // Old timestamp ID - generate new UUID
                playerId = crypto.randomUUID();
                // Update the local player object too
                player.id = playerId;
            }

            return {
                id: playerId,
                name: player.name,
                position: player.position || null,
                team: player.mlbTeam || null,
                notes: player.notes || null,
                owner_id: player.fantasyOwner || null,
                drafted: player.drafted || false,
                draft_notes: player.draftNotes || null,
                updated_at: new Date().toISOString()
            };
        });

        // Process each player individually (same as backupToSupabase)
        supabaseData.forEach(async (playerData) => {
            try {
                await this.supabase
                    .from('players')
                    .upsert(playerData, { onConflict: 'id' });
            } catch (err) {
                console.error('Silent sync error for player:', playerData.name, err);
            }
        });
    }

    clearAllData() {
        this.players = [];
        this.saveToStorage();
        this.render();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // External links functionality
    getExternalLinks(player) {
        return `
            <div class="external-links">
                <span class="external-link baseball-reference-link" onclick="window.draftTracker.openBaseballReference('${this.escapeHtml(player.name)}')" title="Open Baseball-Reference"></span>
                <span class="external-link twitter-link" onclick="window.draftTracker.openTwitter('${this.escapeHtml(player.name)}')" title="Search on Twitter"></span>
            </div>
        `;
    }

    openBaseballReference(playerName) {
        // For now, just use search - no direct URLs implemented yet
        const searchUrl = `https://www.baseball-reference.com/search/search.fcgi?search=${encodeURIComponent(playerName)}`;
        window.open(searchUrl, '_blank');
    }

    openFangraphs(playerName) {
        // Try to get direct player page URL, fallback to search if not found
        const directUrl = this.getFangraphsPlayerUrl(playerName);
        if (directUrl) {
            window.open(directUrl, '_blank');
        } else {
            // Fallback to search if no direct URL found
            const searchUrl = `https://www.fangraphs.com/search.aspx?search=${encodeURIComponent(playerName)}`;
            window.open(searchUrl, '_blank');
        }
    }

    getFangraphsPlayerUrl(playerName) {
        // Fangraphs player ID mapping - add more players as needed
        // Format: "Player Name": "fangraphs-id"
        const fangraphsPlayerIds = {
            // Example players - you can add more as needed
            "Mike Trout": "10155",
            "Aaron Judge": "19753",
            "Shohei Ohtani": "19774",
            "Mookie Betts": "16244",
            "Freddie Freeman": "8657",
            "Juan Soto": "19908",
            "Paul Goldschmidt": "13211",
            "Manny Machado": "11631",
            "Nolan Arenado": "13227",
            "Trea Turner": "15987",
            "Corey Seager": "17708",
            "Bryce Harper": "13580",
            "Jacob deGrom": "11943",
            "Gerrit Cole": "13058",
            "Max Scherzer": "5193",
            "Clayton Kershaw": "3363",
            "Stephen Strasburg": "8979",
            "Justin Verlander": "4509",
            "Zack Greinke": "2777",
            "Madison Bumgarner": "9479",
            // Test players for clean Fangraphs implementation
            "AJ Russell": "12747",
            "Andrew Fischer": "20263",
            "Andrew Salasa": "20308"
        };

        const playerId = fangraphsPlayerIds[playerName];
        if (playerId) {
            return `https://www.fangraphs.com/statss.aspx?playerid=${playerId}&position=P`;
        }

        // Try to find partial matches (useful for players with similar names)
        for (const [name, id] of Object.entries(fangraphsPlayerIds)) {
            if (name.toLowerCase().includes(playerName.toLowerCase()) ||
                playerName.toLowerCase().includes(name.toLowerCase())) {
                return `https://www.fangraphs.com/statss.aspx?playerid=${id}&position=P`;
            }
        }

        return null; // No direct URL found
    }

    openTwitter(playerName) {
        const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(playerName)}&src=typed_query`;
        window.open(searchUrl, '_blank');
    }

    // Get owner colors for row backgrounds - converts UUID to team name and gets colors
    getOwnerColors(ownerId) {
        if (!ownerId) return null;

        // Check if it's a UUID (owner ID) or a team name (backward compatibility)
        const isUUID = typeof ownerId === 'string' &&
            ownerId.length >= 20 &&
            ownerId.includes('-') &&
            !ownerId.match(/^[a-zA-Z]+$/);

        let teamName = ownerId; // Default to the input

        if (isUUID) {
            // Look up the team name from the owners table
            const owner = this.owners.find(o => o.id === ownerId);
            if (owner) {
                teamName = owner.name;
            } else {
                return null; // No colors if owner not found
            }
        }

        // Use existing team colors logic
        return this.getTeamColors(teamName);
    }

    // Get team gradient colors for row backgrounds
    getTeamColors(teamName) {
        if (!teamName) return null;

        const teamNameLower = teamName.toLowerCase().trim();

        const teams = {
            'mets': 'linear-gradient(135deg, #FF5910 0%, #002D72 100%)',
            'yankees': 'linear-gradient(135deg, #0C2340 0%, #C4CED4 100%)',
            'dodgers': 'linear-gradient(135deg, #005A9C 0%, #FFFFFF 100%)',
            'red sox': 'linear-gradient(135deg, #BD3039 0%, #0C2340 100%)',
            'cubs': 'linear-gradient(135deg, #0E3386 0%, #CC3433 100%)',
            'cardinals': 'linear-gradient(135deg, #C41E3A 0%, #0C2340 100%)',
            'braves': 'linear-gradient(135deg, #002244 0%, #CE1141 100%)',
            'giants': 'linear-gradient(135deg, #FD5A1E 0%, #000000 100%)',
            'phillies': 'linear-gradient(135deg, #E81828 0%, #002D5F 100%)',
            'astros': 'linear-gradient(135deg, #002D5F 0%, #EB6E1F 100%)',
            'nationals': 'linear-gradient(135deg, #AB0003 0%, #000000 100%)',
            'padres': 'linear-gradient(135deg, #002D5F 0%, #FFC425 100%)',
            'rockies': 'linear-gradient(135deg, #33006F 0%, #C4CED4 100%)',
            'diamondbacks': 'linear-gradient(135deg, #A71930 0%, #000000 100%)',
            'brewers': 'linear-gradient(135deg, #0A2351 0%, #FFC52F 100%)',
            'pirates': 'linear-gradient(135deg, #000000 0%, #FDB827 100%)',
            'reds': 'linear-gradient(135deg, #C6011F 0%, #000000 100%)',
            'indians': 'linear-gradient(135deg, #0C2340 0%, #E31937 100%)',
            'guardians': 'linear-gradient(135deg, #0C2340 0%, #E31937 100%)',
            'tigers': 'linear-gradient(135deg, #0C2340 0%, #FF6600 100%)',
            'royals': 'linear-gradient(135deg, #004687 0%, #C09B5F 100%)',
            'twins': 'linear-gradient(135deg, #002B5C 0%, #D31145 100%)',
            'white sox': 'linear-gradient(135deg, #000000 0%, #C4CED4 100%)',
            'orioles': 'linear-gradient(135deg, #000000 0%, #FB4F14 100%)',
            'rays': 'linear-gradient(135deg, #092C5C 0%, #8FBCE6 100%)',
            'jays': 'linear-gradient(135deg, #0046AD 0%, #134A8E 100%)',
            'mariners': 'linear-gradient(135deg, #005C5D 0%, #C4CED4 100%)',
            'marlins': 'linear-gradient(135deg, #00A3E0 0%, #000000 100%)', // Miami Marlins teal and black
            'rangers': 'linear-gradient(135deg, #003278 0%, #C0111F 100%)',
            'angels': 'linear-gradient(135deg, #003263 0%, #BA0021 100%)',
            'athletics': 'linear-gradient(135deg, #003831 0%, #EFB21E 100%)'
        };

        return teams[teamNameLower] || null;
    }

    // Owner display functionality - converts UUID to team name and displays with styling
    getOwnerDisplay(ownerId) {
        if (!ownerId) return '';

        console.log('getOwnerDisplay called with:', ownerId, 'owners loaded:', this.owners.length);

        // Check if it's a UUID (owner ID) or a team name (backward compatibility)
        const isUUID = typeof ownerId === 'string' &&
            ownerId.length >= 20 &&
            ownerId.includes('-') &&
            !ownerId.match(/^[a-zA-Z]+$/);

        console.log('isUUID check:', isUUID, 'length:', ownerId?.length, 'includes -:', ownerId?.includes('-'));

        let teamName = ownerId; // Default to the input

        if (isUUID) {
            // Look up the team name from the owners table
            const owner = this.owners.find(o => o.id === ownerId);
            console.log('Owner lookup result:', owner);
            if (owner) {
                teamName = owner.name;
                console.log('Found team name:', teamName);
            } else {
                console.warn('Owner UUID not found in owners table:', ownerId, 'available owners:', this.owners.map(o => ({id: o.id.substring(0,8)+'...', name: o.name})));
                return this.escapeHtml(ownerId); // Show UUID if not found
            }
        }

        // Use existing team display logic
        const result = this.getTeamDisplay(teamName);
        console.log('Final display result:', result);
        return result;
    }

    // Team display functionality
    getTeamDisplay(teamName) {
        if (!teamName) return this.escapeHtml(teamName || '');

        const teamNameLower = teamName.toLowerCase().trim();

        // Team configurations with official colors from encycolorpedia.com
        const teams = {
            'mets': {
                name: 'Mets',
                logo: 'NYM',
                colors: 'linear-gradient(135deg, #FF5910 0%, #002D72 100%)', // Mets Orange and Blue
                textColor: '#FFFFFF'
            },
            'yankees': {
                name: 'Yankees',
                logo: 'NYY',
                colors: 'linear-gradient(135deg, #0C2340 0%, #C41230 100%)', // Yankees Navy and Red
                textColor: '#FFFFFF'
            },
            'dodgers': {
                name: 'Dodgers',
                logo: 'LAD',
                colors: 'linear-gradient(135deg, #005A9C 0%, #A51931 100%)', // Dodgers Blue and Red
                textColor: '#FFFFFF'
            },
            'red sox': {
                name: 'Red Sox',
                logo: 'BOS',
                colors: 'linear-gradient(135deg, #BD3039 0%, #0C2340 100%)', // Red Sox Red and Navy
                textColor: '#FFFFFF'
            },
            'cubs': {
                name: 'Cubs',
                logo: 'CHC',
                colors: 'linear-gradient(135deg, #0E3386 0%, #CC3433 100%)', // Cubs Blue and Red
                textColor: '#FFFFFF'
            },
            'cardinals': {
                name: 'Cardinals',
                logo: 'STL',
                colors: 'linear-gradient(135deg, #C41E3A 0%, #0C2340 100%)', // Cardinals Red and Navy
                textColor: '#FFFFFF'
            },
            'braves': {
                name: 'Braves',
                logo: 'ATL',
                colors: 'linear-gradient(135deg, #002244 0%, #CE1141 100%)', // Braves Navy and Red
                textColor: '#FFFFFF'
            },
            'giants': {
                name: 'Giants',
                logo: 'SFG',
                colors: 'linear-gradient(135deg, #FD5A1E 0%, #000000 100%)', // Giants Orange and Black
                textColor: '#FFFFFF'
            },
            'phillies': {
                name: 'Phillies',
                logo: 'PHI',
                colors: 'linear-gradient(135deg, #E81828 0%, #002D5F 100%)', // Phillies Red and Navy
                textColor: '#FFFFFF'
            },
            'astros': {
                name: 'Astros',
                logo: 'HOU',
                colors: 'linear-gradient(135deg, #002D5F 0%, #EB6E1F 100%)', // Astros Navy and Orange
                textColor: '#FFFFFF'
            },
            'nationals': {
                name: 'Nationals',
                logo: 'WSH',
                colors: 'linear-gradient(135deg, #AB0003 0%, #000000 100%)', // Nationals Red and Black
                textColor: '#FFFFFF'
            },
            'padres': {
                name: 'Padres',
                logo: 'SDP',
                colors: 'linear-gradient(135deg, #154734 0%, #FFC425 100%)', // Padres Navy and Gold
                textColor: '#FFFFFF'
            },
            'rockies': {
                name: 'Rockies',
                logo: 'COL',
                colors: 'linear-gradient(135deg, #33006F 0%, #C4CED4 100%)', // Rockies Purple and Silver
                textColor: '#FFFFFF'
            },
            'diamondbacks': {
                name: 'Diamondbacks',
                logo: 'ARI',
                colors: 'linear-gradient(135deg, #A71930 0%, #000000 100%)', // D-Backs Sedona Red and Black
                textColor: '#FFFFFF'
            },
            'brewers': {
                name: 'Brewers',
                logo: 'MIL',
                colors: 'linear-gradient(135deg, #0A2351 0%, #FFC52F 100%)', // Brewers Navy and Gold
                textColor: '#FFFFFF'
            },
            'pirates': {
                name: 'Pirates',
                logo: 'PIT',
                colors: 'linear-gradient(135deg, #000000 0%, #FDB827 100%)', // Pirates Black and Gold
                textColor: '#FFFFFF'
            },
            'reds': {
                name: 'Reds',
                logo: 'CIN',
                colors: 'linear-gradient(135deg, #C6011F 0%, #000000 100%)', // Reds Red and Black
                textColor: '#FFFFFF'
            },
            'indians': {
                name: 'Indians',
                logo: 'CLE',
                colors: 'linear-gradient(135deg, #0C2340 0%, #E31937 100%)', // Indians Navy and Red
                textColor: '#FFFFFF'
            },
            'guardians': {
                name: 'Guardians',
                logo: 'CLE',
                colors: 'linear-gradient(135deg, #0C2340 0%, #E31937 100%)', // Guardians Navy and Red
                textColor: '#FFFFFF'
            },
            'tigers': {
                name: 'Tigers',
                logo: 'DET',
                colors: 'linear-gradient(135deg, #0C2340 0%, #FF6600 100%)', // Tigers Navy and Orange
                textColor: '#FFFFFF'
            },
            'royals': {
                name: 'Royals',
                logo: 'KCR',
                colors: 'linear-gradient(135deg, #004687 0%, #C09B5F 100%)', // Royals Royal Blue and Gold
                textColor: '#FFFFFF'
            },
            'twins': {
                name: 'Twins',
                logo: 'MIN',
                colors: 'linear-gradient(135deg, #002B5C 0%, #D31145 100%)', // Twins Navy and Red
                textColor: '#FFFFFF'
            },
            'white sox': {
                name: 'White Sox',
                logo: 'CWS',
                colors: 'linear-gradient(135deg, #000000 0%, #C4CED4 100%)', // White Sox Black and Silver
                textColor: '#FFFFFF'
            },
            'orioles': {
                name: 'Orioles',
                logo: 'BAL',
                colors: 'linear-gradient(135deg, #000000 0%, #FB4F14 100%)', // Orioles Black and Orange
                textColor: '#FFFFFF'
            },
            'rays': {
                name: 'Rays',
                logo: 'TBR',
                colors: 'linear-gradient(135deg, #092C5C 0%, #8FBCE6 100%)', // Rays Navy and Light Blue
                textColor: '#FFFFFF'
            },
            'jays': {
                name: 'Jays',
                logo: 'TOR',
                colors: 'linear-gradient(135deg, #0046AD 0%, #134A8E 100%)', // Jays Blue and Dark Blue
                textColor: '#FFFFFF'
            },
            'mariners': {
                name: 'Mariners',
                logo: 'SEA',
                colors: 'linear-gradient(135deg, #005C5D 0%, #C4CED4 100%)', // Mariners Navy and Silver
                textColor: '#FFFFFF'
            },
            'marlins': {
                name: 'Marlins',
                logo: 'MIA',
                colors: 'linear-gradient(135deg, #00A3E0 0%, #000000 100%)', // Miami Marlins teal and black
                textColor: '#FFFFFF'
            },
            'rangers': {
                name: 'Rangers',
                logo: 'TEX',
                colors: 'linear-gradient(135deg, #003278 0%, #C0111F 100%)', // Rangers Navy and Red
                textColor: '#FFFFFF'
            },
            'angels': {
                name: 'Angels',
                logo: 'LAA',
                colors: 'linear-gradient(135deg, #003263 0%, #BA0021 100%)', // Angels Navy and Red
                textColor: '#FFFFFF'
            },
            'athletics': {
                name: 'Athletics',
                logo: 'OAK',
                colors: 'linear-gradient(135deg, #003831 0%, #EFB21E 100%)', // Athletics Green and Gold
                textColor: '#FFFFFF'
            }
        };

        const team = teams[teamNameLower];
        if (team) {
            return `
                <div class="team-display" style="
                    background: ${team.colors};
                    color: ${team.textColor};
                    padding: 4px 8px;
                    border-radius: 12px;
                    font-weight: 600;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                ">
                    <span style="font-size: 14px;">${team.logo}</span>
                    <span>${team.name}</span>
                </div>
            `;
        }

        // Fallback to plain text for non-recognized teams
        return this.escapeHtml(teamName);
    }

    // Notes expansion functionality
    toggleNoteExpansion(playerId, element) {
        // Find the note element for this player
        const noteElement = document.querySelector(`.notes[data-id="${playerId}"]`);
        if (!noteElement) return;

        if (this.expandedNotes.has(playerId)) {
            this.expandedNotes.delete(playerId);
            noteElement.classList.remove('expanded');
        } else {
            this.expandedNotes.add(playerId);
            noteElement.classList.add('expanded');
        }
    }

    closeAllExpandedNotes() {
        this.expandedNotes.clear();
        document.querySelectorAll('.notes.expanded').forEach(elem => {
            elem.classList.remove('expanded');
        });
    }

    // Player card expansion functionality
    togglePlayerCard(playerId) {
        const existingCard = document.querySelector(`.player-card[data-player-id="${playerId}"]`);

        // If card is already expanded, collapse it
        if (existingCard) {
            existingCard.remove();
            return;
        }

        // Close any other expanded cards first
        document.querySelectorAll('.player-card').forEach(card => card.remove());

        // Find the player row and insert card after it
        const playerRow = document.querySelector(`.player-name[data-id="${playerId}"]`)?.closest('tr');
        if (!playerRow) return;

        const player = this.players.find(p => p.id === playerId);
        if (!player) return;

        // Create the expandable card
        const cardRow = document.createElement('tr');
        cardRow.className = 'player-card-row';
        cardRow.innerHTML = `
            <td colspan="6" class="player-card-cell">
                <div class="player-card" data-player-id="${playerId}">
                    <div class="player-card-header">
                        <div class="player-card-info">
                            <h3>${this.escapeHtml(player.name)}</h3>
                            <div class="player-card-details">
                                <span class="position-badge">${this.escapeHtml(player.position || '')}</span>
                                <span class="mlb-team">${this.escapeHtml(player.mlbTeam || '')}</span>
                                ${player.drafted ? `<span class="fantasy-owner">${this.getOwnerDisplay(player.fantasyOwner)}</span>` : '<span class="draft-status available">Available</span>'}
                            </div>
                        </div>
                        <button class="card-close-btn" onclick="window.draftTracker.closePlayerCard('${playerId}')">×</button>
                    </div>
                    <div class="player-card-content">
                        <iframe
                            src="https://www.baseball-reference.com/search/search.fcgi?search=${encodeURIComponent(player.name)}"
                            frameborder="0"
                            width="100%"
                            height="600"
                            loading="lazy"
                            title="Baseball Reference - ${this.escapeHtml(player.name)}"
                        ></iframe>
                    </div>
                </div>
            </td>
        `;

        // Insert the card row after the player row
        playerRow.parentNode.insertBefore(cardRow, playerRow.nextSibling);

        // Scroll the card into view
        setTimeout(() => {
            cardRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }

    closePlayerCard(playerId) {
        // Find and remove the specific player card row
        const cardRow = document.querySelector('.player-card-row');
        if (cardRow) {
            console.log('Removing player card row for player:', playerId);
            cardRow.remove();
        } else {
            console.warn('No player card row found to remove for player:', playerId);
        }
    }



    // Rankings view rendering - NEW TWO-COLUMN LAYOUT
    renderRankingsView() {
        console.log('🎯 renderRankingsView called, current rankings:', this.rankings.length, 'view:', this.rankingsView);
        const container = document.querySelector('.table-container');

        // Load rankings data if not already loaded or wrong type
        if (this.rankings.length === 0 || this.rankings[0]?.list_type !== this.rankingsView) {
            // Only show loading if we haven't tried to load this type yet
            if (!this.rankingsLoaded || this.rankingsLoaded !== this.rankingsView) {
                this.rankingsLoaded = this.rankingsView;
                this.loadRankings(this.rankingsView);
                // Show loading state
                container.innerHTML = '<div class="empty-state"><p>Loading rankings...</p></div>';
                return;
            }
            // If we've already tried loading and still have no rankings, show empty state
            else if (this.rankingsLoaded === this.rankingsView) {
                // Fall through to show empty state below
            }
        }

        // Filter rankings based on search and hide drafted toggle
        let filteredRankings = [...this.rankings];
        if (this.rankingsSearchTerm) {
            const term = this.rankingsSearchTerm.toLowerCase();
            filteredRankings = filteredRankings.filter(ranking => {
                const player = this.players.find(p => p.id === ranking.player_id);
                return player && (
                    player.name.toLowerCase().includes(term) ||
                    player.position.toLowerCase().includes(term) ||
                    player.mlbTeam.toLowerCase().includes(term)
                );
            });
        }

        if (this.hideDraftedInRankings) {
            filteredRankings = filteredRankings.filter(ranking => {
                const player = this.players.find(p => p.id === ranking.player_id);
                return player && !player.drafted;
            });
        }

        // Get available players for the right panel (not in rankings or not drafted)
        const rankedPlayerIds = new Set(filteredRankings.map(r => r.player_id));
        const availablePlayers = this.players.filter(player => {
            // Show all players that aren't in the current rankings OR are drafted (to show with team colors)
            return !rankedPlayerIds.has(player.id) || player.drafted;
        });

        // Create rankings view HTML - NEW TWO-COLUMN LAYOUT
        let html = '<div class="rankings-controls">' +
            '<div class="rankings-header">' +
                '<h2>Player Rankings</h2>' +
                '<div class="rankings-actions">' +
                    '<button id="initializeRankingsBtn" class="btn btn-primary">Initialize Rankings</button>' +
                    '<button id="clearRankingsBtn" class="btn btn-danger">Clear Rankings</button>' +
                '</div>' +
            '</div>' +
            '<div class="rankings-filters">' +
                '<div class="filter-group">' +
                    '<label for="rankingsTypeSelect">List Type:</label>' +
                    '<select id="rankingsTypeSelect">' +
                        '<option value="overall"' + (this.rankingsView === 'overall' ? ' selected' : '') + '>Overall</option>' +
                        '<option value="hitter"' + (this.rankingsView === 'hitter' ? ' selected' : '') + '>Hitters</option>' +
                        '<option value="pitcher"' + (this.rankingsView === 'pitcher' ? ' selected' : '') + '>Pitchers</option>' +
                    '</select>' +
                '</div>' +
                '<div class="filter-group">' +
                    '<input type="text" id="rankingsSearchInput" placeholder="Search players..." value="' + this.escapeHtml(this.rankingsSearchTerm || '') + '">' +
                '</div>' +
                '<div class="filter-group">' +
                    '<label class="checkbox-label">' +
                        '<input type="checkbox" id="hideDraftedRankingsToggle"' + (this.hideDraftedInRankings ? ' checked' : '') + '>' +
                        'Hide drafted players' +
                    '</label>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="rankings-container">' +
            '<!-- LEFT COLUMN: Rankings 1-30 -->' +
            '<div class="rankings-column">' +
                '<h3>Rankings</h3>' +
                '<div class="rankings-list" id="rankingsList">';

        if (filteredRankings.length === 0) {
            html += '<div class="empty-state"><p>No rankings found.<br>Click "Initialize Rankings" to create a default ranking order.</p></div>';
        } else {
            html += '<div class="rankings-items" id="rankingsItems">';
            filteredRankings.forEach(ranking => {
                const player = this.players.find(p => p.id === ranking.player_id);
                if (!player) return;

                html += '<div class="ranking-item" data-id="' + ranking.id + '" data-rank="' + ranking.rank_index + '">' +
                    '<div class="ranking-number">' + ranking.rank_index + '</div>' +
                    '<div class="ranking-content">' +
                        '<div class="ranking-player-name">' + this.escapeHtml(player.name) + '</div>' +
                        '<div class="ranking-player-details">' +
                            '<span class="position-badge">' + this.escapeHtml(player.position || '') + '</span>' +
                            '<span class="mlb-team">' + this.escapeHtml(player.mlbTeam || '') + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="ranking-handle">⋮⋮</div>' +
                '</div>';
            });
            html += '</div>';
        }

        html += '</div>' +
            '</div>' +
            '<!-- RIGHT COLUMN: Player Pool -->' +
            '<div class="player-pool-column">' +
                '<h3>Available Players</h3>' +
                '<div class="player-pool" id="playerPool">';

        if (availablePlayers.length === 0) {
            html += '<div class="empty-state"><p>No available players found.</p></div>';
        } else {
            availablePlayers.forEach(player => {
                const isDrafted = player.drafted;
                const teamColors = isDrafted ? this.getOwnerColors(player.fantasyOwner) : null;

                html += '<div class="pool-player-item' + (isDrafted ? ' drafted' : '') + '" data-id="' + player.id + '"' +
                    (isDrafted && teamColors ? ' style="background: ' + teamColors + '; color: #ffffff;"' : '') + '>' +
                    '<div class="pool-player-name">' + this.escapeHtml(player.name) + '</div>' +
                    '<div class="pool-player-details">' +
                        '<span class="position-badge">' + this.escapeHtml(player.position || '') + '</span>' +
                        '<span class="mlb-team">' + this.escapeHtml(player.mlbTeam || '') + '</span>' +
                        (isDrafted ? '<span class="fantasy-owner">' + this.getOwnerDisplay(player.fantasyOwner) + '</span>' : '') +
                    '</div>' +
                '</div>';
            });
        }

        html += '</div>' +
            '</div>' +
        '</div>';

        container.innerHTML = html;

        // Bind rankings events
        this.bindRankingsEvents();

        // Initialize drag-and-drop if we have rankings
        if (filteredRankings.length > 0) {
            this.initializeDragAndDrop();
        }
    }

    // Rankings data management
    async loadRankings(listType) {
        if (!this.supabase) {
            console.warn('Supabase not available for rankings');
            this.rankings = [];
            return;
        }

        try {
            const { data, error } = await this.supabase
                .from('player_rankings')
                .select('*')
                .eq('list_type', listType)
                .order('rank_index', { ascending: true });

            if (error) {
                console.error('Error loading rankings:', error);
                this.rankings = [];
            } else {
                this.rankings = data || [];
            }

            // Re-render rankings view
            if (this.currentView === 'rankings') {
                this.renderRankingsView();
            }
        } catch (error) {
            console.error('Error loading rankings:', error);
            this.rankings = [];
        }
    }

    async initializeRankings(listType) {
        if (!this.supabase) {
            this.setSyncStatus('Supabase not available', 'error');
            return;
        }

        // Determine which players to include based on list type
        let playersToRank = [...this.players];
        if (listType === 'hitter') {
            playersToRank = playersToRank.filter(p => !p.position || !p.position.includes('P'));
        } else if (listType === 'pitcher') {
            playersToRank = playersToRank.filter(p => p.position && p.position.includes('P'));
        }

        // Sort alphabetically for default order
        playersToRank.sort((a, b) => a.name.localeCompare(b.name));

        // Create ranking entries
        const rankingData = playersToRank.map((player, index) => ({
            player_id: player.id,
            list_type: listType,
            rank_index: index + 1
        }));

        try {
            const { data, error } = await this.supabase
                .from('player_rankings')
                .insert(rankingData);

            if (error) {
                console.error('Error initializing rankings:', error);
                this.setSyncStatus('Error initializing rankings', 'error');
            } else {
                this.setSyncStatus('Rankings initialized successfully', 'success');
                // Reload rankings
                await this.loadRankings(listType);
            }
        } catch (error) {
            console.error('Error initializing rankings:', error);
            this.setSyncStatus('Error initializing rankings', 'error');
        }
    }

    async updateRankingsOrder(newOrder) {
        if (!this.supabase || !newOrder.length) return;

        console.log('Updating rankings order:', newOrder);

        // Get the current filtered rankings to understand what we're reordering
        const filteredRankings = this.currentFilteredRankings || this.getFilteredRankings();
        const listType = this.rankingsView;

        // Simple approach: just reorder the visible rankings and update their positions
        // This works because the drag-and-drop only affects visible rankings
        const reorderedRankings = newOrder.map(id => filteredRankings.find(r => r.id === id)).filter(Boolean);

        if (reorderedRankings.length === 0) {
            this.setSyncStatus('No rankings found to reorder', 'error');
            return;
        }

        // Get all rankings for this type to rebuild the complete list
        const allRankingsForType = this.rankings.filter(r => r.list_type === listType);

        // Create a set of player_ids that are in the reordered rankings to avoid duplicates
        const reorderedPlayerIds = new Set(reorderedRankings.map(r => r.player_id));

        // Get non-filtered rankings, excluding any that are already in the reordered set
        const nonFilteredRankings = allRankingsForType.filter(ranking =>
            !reorderedPlayerIds.has(ranking.player_id) &&
            !filteredRankings.some(fr => fr.id === ranking.id)
        );

        // Create new complete order: reordered visible rankings first, then non-filtered rankings
        const finalOrder = [...reorderedRankings, ...nonFilteredRankings];

        // Create the new ranking data
        const newRankingData = finalOrder.map((ranking, index) => ({
            player_id: ranking.player_id,
            list_type: listType,
            rank_index: index + 1,
            updated_at: new Date().toISOString()
        }));

        try {
            // Delete all rankings for this list_type, then insert new ones
            const { error: deleteError } = await this.supabase
                .from('player_rankings')
                .delete()
                .eq('list_type', listType);

            if (deleteError) {
                console.error('Error deleting old rankings:', deleteError);
                this.setSyncStatus('Error saving rankings order', 'error');
                return;
            }

            // Insert the new rankings in correct order
            const { data, error: insertError } = await this.supabase
                .from('player_rankings')
                .insert(newRankingData)
                .select();

            if (insertError) {
                console.error('Error inserting new rankings:', insertError);
                this.setSyncStatus('Error saving rankings order', 'error');
            } else {
                // Update local rankings data
                this.rankings = data || [];
                this.rankings.sort((a, b) => a.rank_index - b.rank_index);
                this.setSyncStatus('Rankings order saved successfully', 'success');
            }
        } catch (error) {
            console.error('Error updating rankings order:', error);
            this.setSyncStatus('Error saving rankings order', 'error');
        }
    }

    async clearRankings(listType) {
        if (!this.supabase) {
            this.setSyncStatus('Supabase not available', 'error');
            return;
        }

        if (!confirm(`Are you sure you want to clear all ${listType} rankings? This cannot be undone.`)) {
            return;
        }

        try {
            const { error } = await this.supabase
                .from('player_rankings')
                .delete()
                .eq('list_type', listType);

            if (error) {
                console.error('Error clearing rankings:', error);
                this.setSyncStatus('Error clearing rankings', 'error');
            } else {
                this.setSyncStatus('Rankings cleared successfully', 'success');
                // Clear local data and reload
                this.rankings = [];
                this.renderRankingsView();
            }
        } catch (error) {
            console.error('Error clearing rankings:', error);
            this.setSyncStatus('Error clearing rankings', 'error');
        }
    }

    // Rankings event binding
    bindRankingsEvents() {
        // List type selector
        const typeSelect = document.getElementById('rankingsTypeSelect');
        if (typeSelect) {
            typeSelect.addEventListener('change', (e) => {
                this.rankingsView = e.target.value;
                this.loadRankings(this.rankingsView);
            });
        }

        // Search input - use debounced approach to avoid focus loss
        const searchInput = document.getElementById('rankingsSearchInput');
        if (searchInput) {
            // Remove existing event listeners to avoid duplicates
            const newSearchInput = searchInput.cloneNode(true);
            searchInput.parentNode.replaceChild(newSearchInput, searchInput);

            let searchTimeout;
            newSearchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                this.rankingsSearchTerm = e.target.value;

                // Debounce the re-render to avoid focus loss
                searchTimeout = setTimeout(() => {
                    this.renderRankingsView();
                }, 300);
            });
        }

        // Hide drafted toggle
        const hideToggle = document.getElementById('hideDraftedRankingsToggle');
        if (hideToggle) {
            hideToggle.addEventListener('change', (e) => {
                this.hideDraftedInRankings = e.target.checked;
                this.renderRankingsView();
            });
        }

        // Initialize rankings button
        const initBtn = document.getElementById('initializeRankingsBtn');
        if (initBtn) {
            initBtn.addEventListener('click', () => {
                if (this.rankings.length > 0) {
                    if (!confirm('Rankings already exist. Do you want to reinitialize them?')) {
                        return;
                    }
                }
                this.initializeRankings(this.rankingsView);
            });
        }

        // Clear rankings button
        const clearBtn = document.getElementById('clearRankingsBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.clearRankings(this.rankingsView);
            });
        }
    }

    // Drag and drop initialization
    initializeDragAndDrop() {
        const rankingsItems = document.getElementById('rankingsItems');
        if (!rankingsItems) return;

        // Store reference to current filtered rankings for drag-and-drop
        this.currentFilteredRankings = this.getFilteredRankings();

        // Initialize SortableJS
        this.sortableInstance = new Sortable(rankingsItems, {
            handle: '.ranking-handle',
            animation: 150,
            ghostClass: 'ranking-ghost',
            chosenClass: 'ranking-chosen',
            dragClass: 'ranking-drag',
            onEnd: (evt) => {
                // Get new order of ranking IDs from the DOM
                const rankingItems = Array.from(rankingsItems.children);
                const newOrder = rankingItems.map(item => item.dataset.id);

                // Update rankings order in database
                this.updateRankingsOrder(newOrder);

                // Update UI rank numbers immediately
                rankingItems.forEach((item, index) => {
                    const rankNumber = item.querySelector('.ranking-number');
                    if (rankNumber) {
                        rankNumber.textContent = index + 1;
                    }
                });
            }
        });
    }

    // Get filtered rankings (matches the logic in renderRankingsView)
    getFilteredRankings() {
        let filteredRankings = [...this.rankings];

        if (this.rankingsSearchTerm) {
            const term = this.rankingsSearchTerm.toLowerCase();
            filteredRankings = filteredRankings.filter(ranking => {
                const player = this.players.find(p => p.id === ranking.player_id);
                return player && (
                    player.name.toLowerCase().includes(term) ||
                    player.position.toLowerCase().includes(term) ||
                    player.mlbTeam.toLowerCase().includes(term) ||
                    player.notes.toLowerCase().includes(term)
                );
            });
        }

        if (this.hideDraftedInRankings) {
            filteredRankings = filteredRankings.filter(ranking => {
                const player = this.players.find(p => p.id === ranking.player_id);
                return player && !player.drafted;
            });
        }

        return filteredRankings;
    }

    // Position hierarchy for logical sorting
    getPositionHierarchy() {
        return [
            'P',      // Pitchers (SP, RP, CL, etc.)
            'C',      // Catchers
            '1B',     // First Base
            '2B',     // Second Base
            '3B',     // Third Base
            'SS',     // Shortstop
            'OF',     // Outfield
            'DH',     // Designated Hitter
            'UTIL',   // Utility
            'SP',     // Starting Pitcher
            'RP',     // Relief Pitcher
            'CL'      // Closer
        ];
    }

    // Ensure the table structure is restored when switching from by-owner view
    ensureTableStructure() {
        const container = document.querySelector('.table-container');
        if (!container) return;

        // Check if we need to restore the table structure
        const existingTable = container.querySelector('#playersTable');
        if (!existingTable) {
            // Restore the original table structure
            container.innerHTML = `
                <table id="playersTable">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Position</th>
                            <th>MLB Team</th>
                            <th>Fantasy Owner</th>
                            <th>Notes</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="playersTableBody">
                        <!-- Players will be populated here -->
                    </tbody>
                </table>
            `;
        }
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    window.draftTracker = new DraftTracker();
});
