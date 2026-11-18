// Tests only: the boot and Desktop files gos/all-cores edits, as a vendor GOS has them.

/** GOS's boot files as the vendor ships them (bootargs with isolcpus, in a dtb behind two links) + a pinning Desktop drop-in */
export function fakeBootAndDesktop(root: string) {
    Deno.mkdirSync(`${root}/boot/extlinux`, { recursive: true })
    Deno.writeTextFileSync(
        `${root}/boot/extlinux/extlinux.conf`,
        "label rk-kernel.dtb linux-5.10.198\n\tkernel /Image\n\tfdt /rk-kernel.dtb\n",
    )
    const bootargs = new TextEncoder().encode("root=PARTLABEL=rootfs swapaccount=1 isolcpus=4,5,6,7\0")
    Deno.writeFileSync(
        `${root}/boot/board_v2.dtb`,
        new Uint8Array([0xd0, 0x0d, 0xfe, 0xed, 0x80, 0x9f, ...bootargs, 0xff, 0]),
    )
    Deno.symlinkSync("board_v2.dtb", `${root}/boot/board.dtb`)
    Deno.symlinkSync("board.dtb", `${root}/boot/rk-kernel.dtb`)
    const dropins = `${root}/home/user/.config/systemd/user/dimos-desktop.service.d`
    Deno.mkdirSync(dropins, { recursive: true })
    Deno.writeTextFileSync(
        `${dropins}/encoder.conf`,
        "[Service]\nEnvironment=ZDC_PIN_PIPELINES=1\nCPUAffinity=4 5 6 7\n",
    )
}
