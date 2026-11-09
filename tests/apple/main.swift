import Foundation

func range(_ o: [String: Any]) -> BetRange {
    BetRange(min: o["min"] as! Int, max: o["max"] as! Int, opening: o["opening"] as! Bool)
}

let data = try Data(contentsOf: URL(fileURLWithPath: "tests/fixtures/betting.json"))
let fixture = try JSONSerialization.jsonObject(with: data) as! [String: Any]
var count = 0

for row in fixture["step"] as! [[Any]] {
    let blind = row[0] as? Int
    assert(betStep(smallBlind: blind) == row[1] as! Int)
    count += 1
}
for c in fixture["presets"] as! [[String: Any]] {
    let p = betPresets(range: range(c["range"] as! [String: Any]), pot: c["pot"] as! Int, toCall: c["toCall"] as? Int, currentBet: c["currentBet"] as! Int, smallBlind: c["smallBlind"] as? Int)
    let want = c["down"] as! [String: Int]
    assert(p == BetPresets(min: want["min"]!, halfPot: want["halfPot"]!, pot: want["pot"]!, allIn: want["allIn"]!), "presets \(c)")
    count += 1
}
for c in fixture["adjust"] as! [[String: Any]] {
    let r = range(c["range"] as! [String: Any])
    assert(r.adjusted(c["amount"] as! Int, by: c["by"] as! Int) == c["result"] as! Int)
    count += 1
}
for c in fixture["kind"] as! [[String: Any]] {
    let r = range(c["range"] as! [String: Any])
    let kind = r.kind(for: c["to"] as! Int)
    let want = c["result"] as! String
    assert((kind == .allIn && want == "allIn") || (kind == .bet && want == "bet") || (kind == .raise && want == "raise"))
    count += 1
}
let r = BetRange(min: 100, max: 1000, opening: false)
assert(r.adjusted(Int.max - 1, by: 100) == 1000)
assert(r.adjusted(Int.min + 1, by: -100) == 100)
assert(r.allows(100) && !r.allows(99) && !r.allows(1001))
assert(r.canSlide(step: 25) && !BetRange(min: 100, max: 110, opening: false).canSlide(step: 25))
assert(callIsAllIn(call: 200, stack: 200) && !callIsAllIn(call: 200, stack: 500))
assert(betIsAllIn(to: 1000, stack: 900, bet: 100) && !betIsAllIn(to: 999, stack: 900, bet: 100))
print("\(count + 6) betting assertions passed")
