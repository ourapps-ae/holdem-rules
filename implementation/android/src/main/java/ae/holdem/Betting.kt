package ae.holdem

// The betting controls' model: what the amount chooser may offer and what its buttons mean.
// Pure functions over the `bet` range from the legal actions; no screen code.

enum class BetKind { ALL_IN, BET, RAISE }

data class BetPresets(val min: Int, val halfPot: Int, val pot: Int, val allIn: Int)

data class BetRange(val min: Int, val max: Int, val opening: Boolean = false) {
    // Move an amount by a number of chips, held inside the range and safe against overflow.
    fun adjusted(amount: Int, by: Int): Int {
        val value = amount.toLong() + by
        return value.coerceIn(min.toLong(), max.toLong()).toInt()
    }

    // Whether a typed amount may be sent.
    fun allows(amount: Int): Boolean = amount in min..max

    // Whether a slider has anything to slide over.
    fun canSlide(step: Int): Boolean = max - min >= step

    // What the confirm button says for a chosen total.
    fun kind(to: Int): BetKind = if (to == max) BetKind.ALL_IN else if (opening) BetKind.BET else BetKind.RAISE

    // The amount rounded down to the step and held inside the range.
    fun snap(amount: Float, step: Int): Int = ((amount / step).toInt() * step).coerceIn(min, max)
}

// The unit a slider and quick amounts move in: the small blind, at least 1.
fun betStep(smallBlind: Int?): Int = maxOf(1, smallBlind ?: 1)

// The quick amounts: the smallest allowed, half the pot, the pot (each after calling) and all-in.
fun betPresets(range: BetRange, pot: Int, toCall: Int?, currentBet: Int, smallBlind: Int?): BetPresets {
    val call = toCall ?: 0
    val step = betStep(smallBlind)
    return BetPresets(
        min = range.min,
        halfPot = range.snap((pot + call) / 2f + currentBet, step),
        pot = range.snap((pot + call + currentBet).toFloat(), step),
        allIn = range.max)
}

fun callIsAllIn(call: Int, stack: Int): Boolean = call >= stack

fun betIsAllIn(to: Int, stack: Int, bet: Int): Boolean = to >= stack + bet
