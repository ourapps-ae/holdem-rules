import Foundation

// The betting controls' model: what the amount chooser may offer and what its buttons mean.
// Pure functions over the `bet` range from the legal actions; no screen code.

struct BetRange: Hashable {
    let min: Int
    let max: Int
    let opening: Bool

    // Move an amount by a number of chips, held inside the range and safe against overflow.
    func adjusted(_ amount: Int, by step: Int) -> Int {
        let (value, overflow) = amount.addingReportingOverflow(step)
        return Swift.min(max, Swift.max(min, overflow ? (step > 0 ? max : min) : value))
    }

    // Whether a typed amount may be sent.
    func allows(_ amount: Int) -> Bool { (min...max).contains(amount) }

    // Whether a slider has anything to slide over.
    func canSlide(step: Int) -> Bool { max - min >= step }

    // What the confirm button says for a chosen total.
    func kind(for to: Int) -> BetKind { to == max ? .allIn : (opening ? .bet : .raise) }

    // The amount rounded down to the step and held inside the range.
    func snap(_ amount: Double, step: Int) -> Int {
        Swift.min(max, Swift.max(min, Int(amount / Double(step)) * step))
    }
}

enum BetKind: Equatable { case allIn, bet, raise }

struct BetPresets: Equatable {
    let min: Int
    let halfPot: Int
    let pot: Int
    let allIn: Int
}

// The unit a slider and quick amounts move in: the small blind, at least 1.
func betStep(smallBlind: Int?) -> Int { Swift.max(1, smallBlind ?? 1) }

// The quick amounts: the smallest allowed, half the pot, the pot (each after calling) and all-in.
func betPresets(range: BetRange, pot: Int, toCall: Int?, currentBet: Int, smallBlind: Int?) -> BetPresets {
    let call = toCall ?? 0
    let step = betStep(smallBlind: smallBlind)
    return BetPresets(
        min: range.min,
        halfPot: range.snap(Double(pot + call) / 2 + Double(currentBet), step: step),
        pot: range.snap(Double(pot + call + currentBet), step: step),
        allIn: range.max)
}

func callIsAllIn(call: Int, stack: Int) -> Bool { call >= stack }

func betIsAllIn(to: Int, stack: Int, bet: Int) -> Bool { to >= stack + bet }
