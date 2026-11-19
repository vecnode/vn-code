//! Builds cleanly and panics at runtime, on purpose: the backtrace fixture's INPUT.

pub fn inner(depth: u32) -> u32 {
    if depth == 0 {
        panic!("the fixture panics here on purpose");
    }
    inner(depth - 1)
}

fn main() {
    println!("{}", inner(2));
}
