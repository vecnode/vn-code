//! Compiles, and one test fails on purpose: fixture INPUT, not shipped behaviour.

pub fn add(a: u32, b: u32) -> u32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::add;

    #[test]
    fn passes() {
        assert_eq!(add(2, 2), 4);
    }

    #[test]
    fn fails() {
        println!("the fixture prints this line before failing");
        assert_eq!(add(2, 2), 5, "the fixture asserts the wrong sum on purpose");
    }

    #[test]
    #[ignore]
    fn ignored_one() {
        panic!("never runs");
    }
}
