use std::collections::HashMap;

pub(super) const MAX_BROWSER_TABS: usize = 8;

/// Operations performed by the concrete browser-view owner around tab state.
///
/// `BrowserSessionLifecycle` owns ordering and rollback semantics; adapters
/// supply only the platform effects and the data needed to create a view.
pub(super) trait BrowserTabAdapter<Entry> {
    type CreateRequest;

    fn create(&mut self, tab_id: &str, request: Self::CreateRequest) -> Result<Entry, String>;
    fn apply_selection(&mut self, tab_id: &str, entry: &Entry, active: bool) -> Result<(), String>;
    fn close(&mut self, entry: Entry) -> Result<(), String>;
}

#[derive(Default)]
pub(super) struct BrowserTabIndex {
    ids: Vec<String>,
    active_id: Option<String>,
    next_id: u32,
}

impl BrowserTabIndex {
    pub(super) fn open(&mut self) -> Result<String, String> {
        if self.ids.len() >= MAX_BROWSER_TABS {
            return Err(format!(
                "A browser session can have at most {MAX_BROWSER_TABS} tabs."
            ));
        }
        self.next_id = self.next_id.saturating_add(1);
        let id = format!("tab-{}", self.next_id);
        self.ids.push(id.clone());
        self.active_id = Some(id.clone());
        Ok(id)
    }

    pub(super) fn select(&mut self, id: &str) -> Result<(), String> {
        if !self.ids.iter().any(|candidate| candidate == id) {
            return Err("Browser tab does not exist.".to_string());
        }
        self.active_id = Some(id.to_string());
        Ok(())
    }

    pub(super) fn close(&mut self, id: &str) -> Option<String> {
        let index = self.ids.iter().position(|candidate| candidate == id)?;
        let was_active = self.active_id.as_deref() == Some(id);
        self.ids.remove(index);
        if was_active {
            self.active_id = self
                .ids
                .get(index.min(self.ids.len().saturating_sub(1)))
                .cloned();
        }
        self.active_id.clone()
    }

    pub(super) fn active_id(&self) -> Option<&str> {
        self.active_id.as_deref()
    }

    pub(super) fn ids(&self) -> &[String] {
        &self.ids
    }
}

pub(super) struct BrowserSessionLifecycle<Entry> {
    tabs: BrowserTabIndex,
    entries: HashMap<String, Entry>,
}

impl<Entry> Default for BrowserSessionLifecycle<Entry> {
    fn default() -> Self {
        Self {
            tabs: BrowserTabIndex::default(),
            entries: HashMap::new(),
        }
    }
}

impl<Entry> BrowserSessionLifecycle<Entry> {
    /// Reserves the logical tab before creating its platform view. Failed view
    /// creation removes that reservation while leaving the monotonic id
    /// counter advanced, matching the browser tab-open contract.
    pub(super) fn open<Adapter>(
        &mut self,
        adapter: &mut Adapter,
        request: Adapter::CreateRequest,
    ) -> Result<String, String>
    where
        Adapter: BrowserTabAdapter<Entry>,
    {
        let tab_id = self.tabs.open()?;
        match adapter.create(&tab_id, request) {
            Ok(entry) => {
                self.entries.insert(tab_id.clone(), entry);
                Ok(tab_id)
            }
            Err(error) => {
                self.tabs.close(&tab_id);
                Err(error)
            }
        }
    }

    /// Ensures the active logical tab has a view. Unlike `open`, a failed
    /// creation leaves a newly reserved active id in place, preserving the
    /// existing `pi_browser_open` failure semantics.
    pub(super) fn ensure_active_entry<Adapter>(
        &mut self,
        adapter: &mut Adapter,
        request: Adapter::CreateRequest,
    ) -> Result<String, String>
    where
        Adapter: BrowserTabAdapter<Entry>,
    {
        let tab_id = match self.tabs.active_id().map(str::to_string) {
            Some(id) => id,
            None => self.tabs.open()?,
        };
        if !self.entries.contains_key(&tab_id) {
            let entry = adapter.create(&tab_id, request)?;
            self.entries.insert(tab_id.clone(), entry);
        }
        Ok(tab_id)
    }

    /// Commits the selected logical id before applying per-view effects. Any
    /// failed effect returns immediately without rolling that id back.
    pub(super) fn select<Adapter>(
        &mut self,
        tab_id: &str,
        adapter: &mut Adapter,
    ) -> Result<(), String>
    where
        Adapter: BrowserTabAdapter<Entry>,
    {
        self.tabs.select(tab_id)?;
        let active_id = self.tabs.active_id().map(str::to_string);
        for (id, entry) in &mut self.entries {
            adapter.apply_selection(id, entry, active_id.as_deref() == Some(id.as_str()))?;
        }
        Ok(())
    }

    /// Removes the entry and updates active-tab state before closing the
    /// platform view. A close failure does not restore either state change.
    pub(super) fn close<Adapter>(
        &mut self,
        tab_id: &str,
        adapter: &mut Adapter,
    ) -> Result<Option<String>, String>
    where
        Adapter: BrowserTabAdapter<Entry>,
    {
        let entry = self
            .entries
            .remove(tab_id)
            .ok_or_else(|| "Browser tab does not exist.".to_string())?;
        let active_id = self.tabs.close(tab_id);
        adapter.close(entry)?;
        Ok(active_id)
    }

    pub(super) fn active_id(&self) -> Option<&str> {
        self.tabs.active_id()
    }

    pub(super) fn tab_ids(&self) -> &[String] {
        self.tabs.ids()
    }

    pub(super) fn entry(&self, tab_id: &str) -> Option<&Entry> {
        self.entries.get(tab_id)
    }

    pub(super) fn entry_mut(&mut self, tab_id: &str) -> Option<&mut Entry> {
        self.entries.get_mut(tab_id)
    }

    pub(super) fn into_entries(self) -> HashMap<String, Entry> {
        self.entries
    }
}
