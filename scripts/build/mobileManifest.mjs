import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const resources = "linux-unpacked/resources";
const files = [`${resources}/app.asar`];

function collect(directory) {
    for (const entry of readdirSync(path.join("dist", directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) collect(relative);
        else if (entry.isFile()) files.push(relative);
        else throw new Error(`Unexpected non-file in packaged resources: ${relative}`);
    }
}

if (existsSync(`dist/${resources}/app.asar.unpacked`)) collect(`${resources}/app.asar.unpacked`);

const manifest = files
    .sort()
    .map((file) => {
        if (/[\r\n\\]/.test(file)) throw new Error("Unsupported manifest filename");
        const hash = createHash("sha256")
            .update(readFileSync(path.join("dist", file)))
            .digest("hex");
        return `${hash}  ${file}\n`;
    })
    .join("");
writeFileSync("dist/mobile-build.sha256", manifest);
console.log(`Wrote resource checksums for ${files.length} files.`);
