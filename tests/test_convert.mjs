/* 语法转换回归测试
 *
 * 直接从 js/codex_atlas.js 里截取转换段来跑，测的就是真正上线的那份代码，
 * 而不是另抄一份（抄一份就会漂移）。
 *
 * 用例来自工作区的 convert-nai-to-sdxl.js v3（已跑通 10 部法典 29,667 词条）。
 *
 * 跑法：node tests/test_convert.mjs
 */
import fs from "node:fs";

const SRC = new URL("../js/codex_atlas.js", import.meta.url);
const source = fs.readFileSync(SRC, "utf8");

/* 截取「一、NAI → A1111 语法转换」整段：从 fmtWeight 到下一个段标记 */
const start = source.indexOf("function fmtWeight");
const end = source.indexOf("/* ====", start);
if (start < 0 || end < 0) {
  console.error("无法在 codex_atlas.js 里定位转换段，测试脚本需要同步更新");
  process.exit(1);
}

const convertTagsString = new Function(
  source.slice(start, end) + "\nreturn convertTagsString;"
)();

const CASES = [
  ["0.6::mignon,artist:quasarcake,artist:houkisei,40hara::,piromizu,[ke-ta],[modare],year 2024",
   "(mignon, quasarcake, houkisei, 40hara:0.6), piromizu, (ke-ta:0.95), (modare:0.95), year 2024"],
  ["{{{{{{araki hirohiko(style)}}}}}},{{jojo pose}},{{kujo jotaro's pose(jojo)}}",
   "(araki hirohiko\\(style\\):1.34), (jojo pose:1.1), (kujo jotaro's pose\\(jojo\\):1.1)"],
  ["-2::flat color:: | -1::artist collaboration:: | 0.9::sincos::",
   "(sincos:0.9) ||NEG|| flat color, artist collaboration"],
  ["(himukai yuuji:0.1) | (akiyama enma:0.5) | -6::artist collaboration::",
   "(himukai yuuji:0.1), (akiyama enma:0.5) ||NEG|| artist collaboration"],
  ["1.5::amazing quality, 4k, very aesthetic, absurdres::, 1.5::masterpiece::, year 2025, {{year 2024}}",
   "(amazing quality, 4k, very aesthetic, absurdres:1.5), (masterpiece:1.5), year 2025, (year 2024:1.1)"],
  ["0.8::artist: teshima nari::, artist: doremi (doremi4704), artist: baffu",
   "(teshima nari:0.8), doremi \\(doremi4704\\), baffu"],
  ["[[[[[artist:baffu]]]]], [[artist:ritzchrono]], [[[artist:wagashi (dagashiya)]]]",
   "(baffu:0.77), (ritzchrono:0.9), (wagashi \\(dagashiya\\):0.86)"],
  ["1.05::sumiyao (amam)::, 0.9::kedama_milk::",
   "(sumiyao \\(amam\\):1.05), (kedama_milk:0.9)"],
  ["{bad}, {error}, lowres, worst quality",
   "(bad:1.05), (error:1.05), lowres, worst quality"],
  ["2::loli::,2::black_pantyhose::,girl,solo focus",
   "(loli:2), (black_pantyhose:2), girl, solo focus"],
  ["0.5::artist:gogalking ::, 0.7::artist:mika pikazo::, artist:96yottea",
   "(gogalking:0.5), (mika pikazo:0.7), 96yottea"],
  ["-5::text:: | -5::Japanese text::",
   " ||NEG|| text, Japanese text"],
  ["foo, (uten cancel), doremi (doremi4704), (masterpiece, best quality)",
   "foo, (uten cancel), doremi \\(doremi4704\\), (masterpiece, best quality)"],
  ["::satou kuuki::,::raika ken,::,takiki,xipa",
   "satou kuuki, raika ken, takiki, xipa"],
  ["-3::artist collaboration::,1.2::misaka_12003-gou::,0.8::dino_(dinoartforame),wanke,liduke::,1.3::artist:raita::",
   "(misaka_12003-gou:1.2), (dino_\\(dinoartforame\\), wanke, liduke:0.8), (raita:1.3) ||NEG|| artist collaboration"],
  ["(artist:7010:0.8), (artist:mikozin:0.8), (uten cancel), appleq, amem",
   "(7010:0.8), (mikozin:0.8), (uten cancel), appleq, amem"],
  ["{{artist:dsmile}},[[artist:noyu_(noyu23386566)]],{artist:fuzichoco},aritst:hu_pi_xuan_jiao",
   "(dsmile:1.1), (noyu_\\(noyu23386566\\):0.9), (fuzichoco:1.05), hu_pi_xuan_jiao"],
  ["0.6::mignon,artist:quasarcake,artist:kedama milk,40hara::,piromizu",
   "(mignon, quasarcake, kedama milk, 40hara:0.6), piromizu"],
  ["-3::artist collaboration::, 0.8::wolrero, artist:ronna::, 1.5::namaonpa::",
   "(wolrero, ronna:0.8), (namaonpa:1.5) ||NEG|| artist collaboration"],
  ["::,,__artist__, year 2024,,(sideways glance:1.2), (close-up:0.8),,profile",
   "__artist__, year 2024, (sideways glance:1.2), (close-up:0.8), profile"],
  ["rating:general, nsfw, top aesthetic, 1.5:chen_bin:, 0.3:fuzichoco:, [0.3:rei (sanbonzakura):], [0.3:mikozin:], [0.3misawa hiroshi:], rolua, oil_painting_(medium)",
   "rating:general, nsfw, top aesthetic, (chen_bin:1.5), (fuzichoco:0.3), ((rei \\(sanbonzakura\\):0.3):0.95), ((mikozin:0.3):0.95), ((misawa hiroshi:0.3):0.95), rolua, oil_painting_\\(medium\\)"],
  ["1.8::{{artist:sigm@}}, {artist:mochirong}, [[[artist:hepari]]], {artist:parsley-f} ::, 2::{year 2025, year 2024} ::, 0.7::artist:jp06, artist:nashidrop",
   "((sigm@:1.1), (mochirong:1.05), (hepari:0.86), (parsley-f:1.05):1.8), ((year 2025, year 2024:1.05):2), (jp06:0.7), nashidrop"],
  ["kagura nana,{{shexyo:year 2025,dikko:year 2025,ipuu (el-ane_koubou)},-2::grayscale::,1girl,solo",
   "kagura nana, (shexyo:year 2025, dikko:year 2025, ipuu \\(el-ane_koubou\\):1.05), 1girl, solo ||NEG|| grayscale"],
  ["foo, -3::::, bar, (dagashiya)}}, iuui",
   "foo, bar, (dagashiya), iuui"],
  ["2::[[atist:sumiyao \\(amam\\)]], {artist:reel \\(riru\\)}, [[[artist:utsusumi kio]]] ::, 1.1::[[[artist:rong hui]]]",
   "((sumiyao \\(amam\\):0.9), (reel \\(riru\\):1.05), (utsusumi kio:0.86):2), ((rong hui:0.86):1.1)"],
  ["0.85::min_(120716)::, artist:daram_(shappydude), -5::artist collaboration::, -5::dark-skinned male::, -3::doll::, year_2024",
   "(min_\\(120716\\):0.85), daram_\\(shappydude\\), year_2024 ||NEG|| artist collaboration, dark-skinned male, doll"],
];

let fail = 0;

for (const [input, expect] of CASES) {
  const { positive, negative } = convertTagsString(input);
  const got = (positive || "") + (negative ? ` ||NEG|| ${negative}` : "");
  if (got !== expect) {
    fail++;
    console.log(`FAIL  in: ${input}`);
    console.log(`      got: ${got}`);
    console.log(`      exp: ${expect}`);
  }
}

/* 负向 sink 与多角色两条独立断言 */
const n1 = convertTagsString("-2::flat color:: | -1::artist collaboration::");
if (n1.negative !== "flat color, artist collaboration") {
  fail++;
  console.log("FAIL  negative sink:", JSON.stringify(n1));
}

const n2 = convertTagsString("girl, 2::loli::,2::black_pantyhose::,");
if (n2.positive !== "girl, (loli:2), (black_pantyhose:2)") {
  fail++;
  console.log("FAIL  charprompt:", JSON.stringify(n2));
}

console.log(`\n用例 ${CASES.length + 2} 个，通过 ${CASES.length + 2 - fail} 个`);
console.log(fail === 0 ? "语法转换测试全部通过" : `${fail} 个用例失败`);
process.exit(fail === 0 ? 0 : 1);
