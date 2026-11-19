//! Deliberately broken: a type error, a borrow error, and a failing test.
//! This file is fixture INPUT, not shipped behaviour.

/// Two distinct mistakes in one function: a mismatched type and a moved value.
pub fn mismatched() -> u32 {
    let text: u32 = "not a number";
    text
}

/// The same mistake at several call sites, so deduplication has something to collapse.
pub fn repeated() -> u32 {
    let a: u32 = "one";
    let b: u32 = "two";
    a + b
}

#[cfg(test)]
mod tests {
    #[test]
    fn this_one_fails() {
        println!("about to fail on purpose");
        assert_eq!(2 + 2, 5, "arithmetic is not what this fixture assumes");
    }

    #[test]
    fn this_one_passes() {
        assert_eq!(2 + 2, 4);
    }
}
