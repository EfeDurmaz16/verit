use std::io::Read;

pub struct Ledger {
    total: u64,
}

impl Ledger {
    pub fn post(&mut self, amount: u64) {
        self.total += amount;
    }
}

pub trait Audit {
    fn check(&self) -> bool;
}

pub fn audit(l: &Ledger) -> bool {
    l.total > 0
}
