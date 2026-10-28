// 本地曲库标签整理交互
(() => {
    const rootInput = document.getElementById("metadata-root");
    const scanButton = document.getElementById("metadata-scan");
    const applyButton = document.getElementById("metadata-apply-selected");
    const matchButton = document.getElementById("metadata-match-selected");
    const selectUnmatchedButton = document.getElementById("metadata-select-unmatched");
    const batchPlatformInput = document.getElementById("metadata-batch-platform");
    const batchLimitInput = document.getElementById("metadata-batch-limit");
    const overwriteInput = document.getElementById("metadata-overwrite");
    const filterInput = document.getElementById("metadata-filter");
    const rowsEl = document.getElementById("metadata-rows");
    const emptyEl = document.getElementById("metadata-empty");
    const tableWrap = document.getElementById("metadata-table-wrap");
    const modalEl = document.getElementById("metadata-search-modal");
    const searchModal = bootstrap.Modal.getOrCreateInstance(modalEl);
    let items = [];
    let rootPath = "";
    let activeIndex = -1;
    let running = false;

    const labels = { title: "标题", artist: "歌手", album: "专辑", cover: "封面" };
    const platformNames = { netease: "网易云", qq: "QQ音乐", kugou: "酷狗", ximalaya: "喜马拉雅" };

    // 按当前筛选条件生成曲目行，文本内容统一转义后插入页面。
    function formatMissing(item) {
        if (item.read_error) return '<span class="metadata-tag missing">标签读取失败</span>';
        if (!item.missing.length) return '<span class="metadata-tag">标签齐全</span>';
        return item.missing.map(key => `<span class="metadata-tag missing">缺${labels[key] || escapeHtml(key)}</span>`).join("");
    }

    // 外部文件的人工匹配优先于数据库的来源记录。
    function currentSource(item) {
        return item.selectedSource || item.source || null;
    }

    function sourceText(item) {
        const source = currentSource(item);
        if (!source) return '<span class="text-muted">尚未匹配</span>';
        const type = source.match_method === "batch" ? "批量候选 · 请核对" : item.selectedSource ? "已确认候选" : "下载记录精确匹配";
        const sourceKind = source.source_type === "program" ? " · 节目" : source.source_type === "ximalaya_track" ? " · 声音" : "";
        return `<strong>${escapeHtml(platformNames[source.platform] || source.platform)}${sourceKind} · ${escapeHtml(type)}</strong><small>${escapeHtml(source.name || source.song_id || "")}${source.artists ? " / " + escapeHtml(source.artists) : ""}</small>`;
    }

    // 生成表格行并显示标签缺项、来源和当前操作状态。
    function rowMarkup(item, index) {
        const tags = item.tags || {};
        const title = tags.title || item.name;
        const info = [tags.artist, tags.album].filter(Boolean).map(escapeHtml).join(" · ");
        const action = currentSource(item)
            ? `<button class="btn metadata-action-btn" data-action="apply" data-index="${index}" ${item.read_error || running ? "disabled" : ""}><i class="bi bi-magic me-1"></i>写入标签</button>`
            : `<button class="btn metadata-action-btn search" data-action="search" data-index="${index}" ${item.read_error || running ? "disabled" : ""}><i class="bi bi-search me-1"></i>匹配来源</button>`;
        const checkable = !item.read_error;
        const checked = checkable && Boolean(item.selected);
        let result = "";
        if (item.result === "done") result = '<span class="metadata-row-status done"><i class="bi bi-check-circle"></i> 已写入</span>';
        if (item.result === "error") result = `<span class="metadata-row-status error"><i class="bi bi-exclamation-circle"></i> ${escapeHtml(item.error || "写入失败")}</span>`;
        return `<tr>
            <td class="metadata-check-col"><input class="metadata-check" type="checkbox" data-check="${index}" aria-label="选择 ${escapeHtml(item.name)}" ${checked ? "checked" : ""} ${!checkable || running ? "disabled" : ""}></td>
            <td><div class="metadata-file-name">${escapeHtml(title)}</div><div class="metadata-file-sub">${info || escapeHtml(item.relative_path)} <span>· ${formatSize(item.size)}</span></div>${result}</td>
            <td><div class="metadata-tag-list">${formatMissing(item)}</div></td>
            <td><div class="metadata-source">${sourceText(item)}</div></td>
            <td class="text-end">${action}</td>
        </tr>`;
    }

    // 根据筛选器挑选需要显示的行，同时保留原始索引供操作回写。
    function visibleItems() {
        const filter = filterInput.value;
        return items.map((item, index) => ({ item, index })).filter(({ item }) => {
            if (filter === "missing" && !item.missing.length) return false;
            if (filter === "unmatched" && currentSource(item)) return false;
            if (filter === "matched" && !currentSource(item)) return false;
            return true;
        });
    }

    // 刷新统计、列表和可批量写入的数量。
    function render() {
        const visible = visibleItems();
        rowsEl.innerHTML = visible.map(({ item, index }) => rowMarkup(item, index)).join("");
        const total = items.length;
        const incomplete = items.filter(item => item.missing.length > 0 || item.read_error).length;
        const linked = items.filter(item => item.source).length;
        document.getElementById("metadata-total").textContent = String(total);
        document.getElementById("metadata-incomplete").textContent = String(incomplete);
        document.getElementById("metadata-linked").textContent = String(linked);
        const selectedCount = items.filter(item => item.selected && currentSource(item) && !item.read_error).length;
        const selectedUnmatchedCount = items.filter(item => item.selected && !currentSource(item) && !item.read_error).length;
        const visibleUnmatchedCount = visible.filter(({ item }) => !currentSource(item) && !item.read_error).length;
        document.getElementById("metadata-selected-count").textContent = String(selectedCount);
        document.getElementById("metadata-match-count").textContent = String(selectedUnmatchedCount);
        applyButton.disabled = running || selectedCount === 0;
        matchButton.disabled = running || selectedUnmatchedCount === 0;
        selectUnmatchedButton.disabled = running || visibleUnmatchedCount === 0;
        batchPlatformInput.disabled = running;
        batchLimitInput.disabled = running;
        filterInput.disabled = running;
        emptyEl.classList.toggle("d-none", total > 0);
        tableWrap.classList.toggle("d-none", total === 0);
        document.getElementById("metadata-truncated").classList.add("d-none");
    }

    // 首次扫描时只勾选有精确下载记录且确实缺项的文件。
    function selectDefaultRows() {
        items.forEach(item => { item.selected = Boolean(item.source && item.missing.length); });
    }

    // 扫描用户指定的容器目录，不在页面打开时自动遍历文件。
    async function scan() {
        if (running) return;
        scanButton.disabled = true;
        scanButton.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>扫描中';
        try {
            const response = await api("/api/metadata/scan", {
                method: "POST",
                timeout: 60000,
                body: JSON.stringify({ root: rootInput.value.trim() }),
            });
            rootPath = response.data.root;
            rootInput.value = rootPath;
            items = response.data.items.map(item => ({ ...item, selectedSource: null, selected: false, result: "", error: "" }));
            selectDefaultRows();
            document.getElementById("metadata-truncated").classList.toggle("d-none", !response.data.truncated);
            if (response.data.truncated) {
                document.getElementById("metadata-truncated").textContent = "目录文件较多，本次显示前 5000 个受支持音频。可指定更窄的子目录继续整理。";
            }
            document.getElementById("metadata-progress").textContent = "";
            render();
            if (!items.length) showToast("该目录中没有发现受支持的音频文件", "扫描完成");
        } catch (error) {
            showToast(error.message, "扫描失败");
        } finally {
            scanButton.disabled = false;
            scanButton.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>扫描曲库';
        }
    }

    // 打开单曲匹配窗口，并用现有标签和文件名填入搜索词。
    function openSearch(index) {
        activeIndex = index;
        const item = items[index];
        const tags = item.tags || {};
        document.getElementById("metadata-query").value = item.search_hint || tags.title || item.name.replace(/\.[^.]+$/, "");
        document.getElementById("metadata-platform").value = "netease";
        document.getElementById("metadata-candidates").innerHTML = '<p class="metadata-candidates-empty">搜索后请核对标题、作者和专辑，再选择正确版本。</p>';
        searchModal.show();
        setTimeout(() => document.getElementById("metadata-query").focus(), 150);
    }

    // 通过现有发现接口查询候选歌曲，由用户确认正确版本。
    async function searchCandidates() {
        const keyword = document.getElementById("metadata-query").value.trim();
        const selectedMode = document.getElementById("metadata-platform").value;
        // QQ 节目和喜马拉雅声音使用独立来源类型，避免进入歌曲详情接口。
        const platform = selectedMode === "qq_program" ? "qq" : selectedMode;
        const searchType = selectedMode === "qq_program" ? "program" : "song";
        const sourceType = selectedMode === "qq_program" ? "program" : selectedMode === "ximalaya" ? "ximalaya_track" : "song";
        const target = document.getElementById("metadata-candidates");
        if (!keyword) {
            showToast("输入歌曲、节目或声音名 / 作者后再搜索");
            return;
        }
        target.innerHTML = '<p class="metadata-candidates-empty"><span class="loading-spinner"></span> 正在搜索候选…</p>';
        try {
            const response = await api("/api/discover/search", {
                method: "POST",
                timeout: 30000,
                body: JSON.stringify({ keyword, platform, type: searchType, limit: 15, offset: 0 }),
            });
            const candidates = (response.data.items || []).filter(candidate => candidate.id);
            if (!candidates.length) {
                target.innerHTML = '<p class="metadata-candidates-empty">没有找到候选。可以换关键词或平台再试。</p>';
                return;
            }
            target.innerHTML = candidates.map((candidate, index) => `<article class="metadata-candidate">
                <div><strong>${escapeHtml(candidate.name || (sourceType === "program" ? "未知节目" : sourceType === "ximalaya_track" ? "未知声音" : "未知歌曲"))}</strong><small>${escapeHtml(candidate.artists || "未知作者")} · ${escapeHtml(candidate.album || "未知专辑")}</small></div>
                <button class="btn" type="button" data-candidate="${index}">选这个</button>
            </article>`).join("");
            target.querySelectorAll("[data-candidate]").forEach(button => {
                button.addEventListener("click", () => {
                    const candidate = candidates[Number(button.dataset.candidate)];
                    const item = items[activeIndex];
                    item.selectedSource = {
                        platform,
                        source_type: sourceType,
                        song_id: String(candidate.id),
                        name: candidate.name || "",
                        artists: candidate.artists || "",
                        album: candidate.album || "",
                        cover_url: candidate.cover_url || "",
                    };
                    item.selected = true;
                    item.result = "";
                    item.error = "";
                    searchModal.hide();
                    render();
                    showToast(`已匹配：${candidate.name || (sourceType === "program" ? "节目" : sourceType === "ximalaya_track" ? "声音" : "歌曲")}`, "候选已确认");
                });
            });
        } catch (error) {
            target.innerHTML = `<p class="metadata-candidates-empty">${escapeHtml(error.message)}</p>`;
        }
    }

    // 选中当前筛选结果里尚未关联来源且可读取的文件。
    function selectVisibleUnmatched() {
        let selectedCount = 0;
        visibleItems().forEach(({ item }) => {
            if (currentSource(item) || item.read_error) return;
            item.selected = true;
            selectedCount += 1;
        });
        render();
        if (selectedCount) showToast(`已选择 ${selectedCount} 个未匹配文件`, "批量匹配");
    }

    // 对所选未匹配文件逐首搜索，暂取首个候选，用户确认写入前仍可核对或重搜。
    async function batchMatchSelected() {
        if (running) return;
        const allTargets = items.map((item, index) => ({ item, index }))
            .filter(({ item }) => item.selected && !currentSource(item) && !item.read_error);
        const batchLimit = Number(batchLimitInput.value);
        // 每轮数量只能在 1 到 500 之间，避免超过界面允许的上限。
        if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 500) {
            showToast("每轮匹配数量需设置为 1–500", "数量无效");
            batchLimitInput.focus();
            return;
        }
        const targets = allTargets.slice(0, batchLimit);
        if (!targets.length) return;

        const selectedMode = batchPlatformInput.value;
        const platform = selectedMode === "qq_program" ? "qq" : selectedMode;
        const searchType = selectedMode === "qq_program" ? "program" : "song";
        const sourceType = selectedMode === "qq_program" ? "program" : selectedMode === "ximalaya" ? "ximalaya_track" : "song";
        const progress = document.getElementById("metadata-progress");
        let matched = 0;
        let notFound = 0;
        let failed = 0;
        running = true;
        scanButton.disabled = true;
        progress.textContent = `0 / ${targets.length}`;
        render();

        for (let index = 0; index < targets.length; index += 1) {
            const { item } = targets[index];
            const title = (item.tags?.title || item.name.replace(/\.[^.]+$/, "")).trim();
            const keyword = selectedMode === "ximalaya" ? title : (item.search_hint || title);
            try {
                const response = await api("/api/discover/search", {
                    method: "POST",
                    timeout: 30000,
                    body: JSON.stringify({ keyword, platform, type: searchType, limit: 15, offset: 0 }),
                });
                const candidate = (response.data.items || []).find(result => result.id);
                if (!candidate) {
                    item.selected = false;
                    item.result = "error";
                    item.error = "没有找到候选";
                    notFound += 1;
                } else {
                    item.selectedSource = {
                        platform,
                        source_type: sourceType,
                        match_method: "batch",
                        song_id: String(candidate.id),
                        name: candidate.name || "",
                        artists: candidate.artists || "",
                        album: candidate.album || "",
                        cover_url: candidate.cover_url || "",
                    };
                    item.selected = true;
                    item.result = "";
                    item.error = "";
                    matched += 1;
                }
            } catch (error) {
                item.selected = false;
                item.result = "error";
                item.error = error.message;
                failed += 1;
            }
            progress.textContent = `${index + 1} / ${targets.length}`;
        }

        running = false;
        scanButton.disabled = false;
        const remaining = allTargets.length - targets.length;
        if (matched && filterInput.value === "unmatched") filterInput.value = "all";
        progress.textContent = remaining
            ? `本轮完成 ${targets.length} 首，剩余 ${remaining} 首待匹配`
            : `${matched} 首有候选 · ${notFound} 首无结果 · ${failed} 首失败`;
        render();
        showToast(
            remaining
                ? `本轮匹配 ${matched} 首，剩余 ${remaining} 首可再次批量匹配`
                : `匹配到 ${matched} 首候选，${notFound} 首无结果，${failed} 首失败；确认后再批量写入`,
            "批量匹配完成",
        );
    }

    // 将数据库记录或人工候选统一成接口接受的回退字段。
    function sourceFallback(source) {
        return {
            name: source.name || "",
            title: source.name || "",
            artists: source.artists || "",
            artist: source.artists || "",
            album: source.album || "",
            cover_url: source.cover_url || "",
        };
    }

    // 只写入当前确认的歌曲标签，并保留已有封面和歌词。
    async function applyOne(index) {
        const item = items[index];
        const source = currentSource(item);
        if (!source) return false;
        item.result = "";
        item.error = "";
        render();
        try {
            const response = await api("/api/metadata/apply", {
                method: "POST",
                timeout: 30000,
                body: JSON.stringify({
                    root: rootPath,
                    relative_path: item.relative_path,
                    platform: source.platform,
                    source_type: source.source_type || "song",
                    song_id: source.song_id,
                    fallback: sourceFallback(source),
                    overwrite: overwriteInput.checked,
                }),
            });
            item.tags = response.data.tags;
            item.missing = [];
            if (!item.tags.title) item.missing.push("title");
            if (!item.tags.artist) item.missing.push("artist");
            if (!item.tags.album) item.missing.push("album");
            if (!item.tags.has_cover) item.missing.push("cover");
            item.result = "done";
            item.selected = false;
            return true;
        } catch (error) {
            item.result = "error";
            item.error = error.message;
            return false;
        } finally {
            render();
        }
    }

    // 两个并发写入 worker 处理已选项目，避免集中请求来源接口。
    async function applySelected() {
        if (running) return;
        const targets = items.map((item, index) => ({ item, index }))
            .filter(({ item }) => item.selected && currentSource(item) && !item.read_error);
        if (!targets.length) return;
        running = true;
        scanButton.disabled = true;
        applyButton.disabled = true;
        let completed = 0;
        document.getElementById("metadata-progress").textContent = `0 / ${targets.length}`;
        render();
        let cursor = 0;
        async function worker() {
            while (cursor < targets.length) {
                const target = targets[cursor++];
                await applyOne(target.index);
                completed += 1;
                document.getElementById("metadata-progress").textContent = `${completed} / ${targets.length}`;
            }
        }
        await Promise.all([worker(), worker()]);
        running = false;
        scanButton.disabled = false;
        const succeeded = targets.filter(({ item }) => item.result === "done").length;
        const failed = targets.length - succeeded;
        document.getElementById("metadata-progress").textContent = failed ? `${succeeded} 成功 · ${failed} 失败` : `${succeeded} 首已完成`;
        render();
        showToast(failed ? `${succeeded} 首已写入，${failed} 首失败，可查看行内原因` : `已写入 ${succeeded} 首歌曲标签`, "整理完成");
    }

    scanButton.addEventListener("click", scan);
    applyButton.addEventListener("click", applySelected);
    matchButton.addEventListener("click", batchMatchSelected);
    selectUnmatchedButton.addEventListener("click", selectVisibleUnmatched);
    filterInput.addEventListener("change", render);
    document.getElementById("metadata-search-button").addEventListener("click", searchCandidates);
    document.getElementById("metadata-query").addEventListener("keydown", event => {
        if (event.key === "Enter") searchCandidates();
    });
    rowsEl.addEventListener("click", event => {
        const button = event.target.closest("[data-action]");
        if (!button) return;
        const index = Number(button.dataset.index);
        if (button.dataset.action === "search") openSearch(index);
        if (button.dataset.action === "apply") applyOne(index).then(ok => {
            if (ok) showToast("标签和封面已写入音频文件", "整理完成");
        });
    });
    rowsEl.addEventListener("change", event => {
        const checkbox = event.target.closest("[data-check]");
        if (!checkbox) return;
        items[Number(checkbox.dataset.check)].selected = checkbox.checked;
        render();
    });

})();
