import ae.holdem.BetKind
import ae.holdem.BetPresets
import ae.holdem.BetRange
import ae.holdem.betIsAllIn
import ae.holdem.betPresets
import ae.holdem.betStep
import ae.holdem.callIsAllIn
import java.io.File

// Reads the same fixture as the web and Apple checks, with a minimal reader for its fixed shape.
private val text = File("tests/fixtures/betting.json").readText()

private fun section(name: String): String {
    val start = text.indexOf("\"$name\"")
    val open = text.indexOf('[', start)
    var depth = 0
    for (i in open until text.length) {
        if (text[i] == '[') depth++
        if (text[i] == ']') { depth--; if (depth == 0) return text.substring(open, i + 1) }
    }
    error("section $name")
}

private fun objects(body: String): List<String> {
    val out = mutableListOf<String>()
    var depth = 0
    var from = -1
    for ((i, c) in body.withIndex()) {
        if (c == '{') { if (depth == 0) from = i; depth++ }
        if (c == '}') { depth--; if (depth == 0) out.add(body.substring(from, i + 1)) }
    }
    return out
}

private fun int(o: String, key: String): Int? = Regex("\"$key\": *(-?\\d+|null)").find(o)?.groupValues?.get(1)?.toIntOrNull()
private fun str(o: String, key: String): String = Regex("\"$key\": *\"(\\w+)\"").find(o)!!.groupValues[1]
private fun range(o: String): BetRange {
    val r = Regex("\"range\": *(\\{[^}]*\\})").find(o)!!.groupValues[1]
    return BetRange(int(r, "min")!!, int(r, "max")!!, r.contains("\"opening\": true"))
}

fun main() {
    var count = 0
    for (c in objects(section("presets"))) {
        val down = Regex("\"down\": *(\\{[^}]*\\})").find(c)!!.groupValues[1]
        val want = BetPresets(int(down, "min")!!, int(down, "halfPot")!!, int(down, "pot")!!, int(down, "allIn")!!)
        val got = betPresets(range(c), int(c, "pot")!!, int(c, "toCall"), int(c, "currentBet")!!, int(c, "smallBlind"))
        check(got == want) { "presets $c: $got" }
        count++
    }
    for (c in objects(section("adjust"))) {
        check(range(c).adjusted(int(c, "amount")!!, int(c, "by")!!) == int(c, "result")) { "adjust $c" }
        count++
    }
    for (c in objects(section("kind"))) {
        val want = when (str(c, "result")) { "allIn" -> BetKind.ALL_IN; "bet" -> BetKind.BET; else -> BetKind.RAISE }
        check(range(c).kind(int(c, "to")!!) == want) { "kind $c" }
        count++
    }
    check(betStep(null) == 1 && betStep(0) == 1 && betStep(25) == 25)
    val r = BetRange(100, 1000)
    check(r.adjusted(Int.MAX_VALUE - 1, 100) == 1000)
    check(r.adjusted(Int.MIN_VALUE + 1, -100) == 100)
    check(r.allows(100) && !r.allows(99) && !r.allows(1001))
    check(r.canSlide(25) && !BetRange(100, 110).canSlide(25))
    check(callIsAllIn(200, 200) && !callIsAllIn(200, 500))
    check(betIsAllIn(1000, 900, 100) && !betIsAllIn(999, 900, 100))
    println("${count + 6} betting assertions passed")
}
