import { build } from 'esbuild';

// 🌟 إضافة (Plugin) ذكية لاصطياد جميع مسارات libsignal المفقودة وإصلاحها تلقائياً
const fixLibSignalPlugin = {
    name: 'fix-libsignal-extensions',
    setup(build) {
        // اعتراض أي استدعاء يبدأ بـ libsignal/src/
        build.onResolve({ filter: /^libsignal\/src\// }, args => {
            if (!args.path.endsWith('.js')) {
                // إضافة امتداد .js وإخبار المترجم أنه ملف خارجي
                return { path: args.path + '.js', external: true };
            }
        });
    }
};

async function runBuild() {
    console.log('⏳ جاري بناء وتعمية المشروع...');
    
    await build({
        entryPoints: ['src/api/server.ts'], // أو src/server.ts حسب مسارك
        bundle: true,
        packages: 'external',
        platform: 'node',
        target: 'node20',
        format: 'esm', 
        minify: true,
        outfile: 'dist/server.bundle.js',
        plugins: [fixLibSignalPlugin] // 🌟 تفعيل الإضافة هنا
    });
    
    console.log('✅ تم البناء بنجاح! جميع مسارات libsignal تم إصلاحها.');
}

runBuild().catch(err => {
    console.error('❌ حدث خطأ أثناء البناء:', err);
    process.exit(1);
});