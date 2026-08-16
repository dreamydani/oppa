pub struct PtySession {
    pub id: String,
}

impl PtySession {
    pub fn new(id: String) -> Self {
        Self { id }
    }
}
